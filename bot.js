import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const PRICES_PATH = path.join(__dirname, "prices.json");
const LOG_PATH = path.join(__dirname, "results.log");

// --- Config loading ---

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`config.json not found at ${CONFIG_PATH}. Please create it before running the bot.`);
  }
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (e) {
    throw new Error(`Failed to read config.json: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`config.json is malformed JSON: ${e.message}`);
  }
}

function loadPrices() {
  if (!fs.existsSync(PRICES_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(PRICES_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function savePrices(prices) {
  fs.writeFileSync(PRICES_PATH, JSON.stringify(prices, null, 2));
}

// --- Logging ---

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

function logAlert(route, flight, alertType) {
  const record = {
    ts: new Date().toISOString(),
    route: route.name,
    alertType,
    price: flight.price,
    airline: flight.airline,
    stops: flight.stops,
    duration: flight.duration,
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
}

// --- Date helpers ---

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateVariants(route) {
  const flex = route.flexDays ?? 0;
  if (flex === 0) return [route];

  const variants = [];
  for (let offset = -flex; offset <= flex; offset++) {
    variants.push({
      ...route,
      departureDate: shiftDate(route.departureDate, offset),
      returnDate: route.returnDate ? shiftDate(route.returnDate, offset) : undefined,
      _dateLabel: `dep ${shiftDate(route.departureDate, offset)}`,
    });
  }
  return variants;
}

// --- URL building ---

function buildUrl(route) {
  const depStr = route.departureDate;
  if (!depStr) throw new Error(`Route "${route.name}" is missing "departureDate"`);

  let query;
  if (route.roundTrip) {
    const retStr = route.returnDate;
    if (!retStr) throw new Error(`Route "${route.name}" is missing "returnDate" for a round trip`);
    query = `Round-trip ${route.from} to ${route.to} ${depStr} return ${retStr}`;
  } else {
    query = `One-way ${route.from} to ${route.to} ${depStr}`;
  }

  const currency = route.currency ?? "USD";
  return `https://www.google.com/travel/flights/search?q=${encodeURIComponent(query)}&curr=${currency}&hl=en`;
}

// --- Popup dismissal ---

async function dismissPopups(page) {
  const selectors = [
    'button[aria-label="Accept all"]',
    'button[aria-label="Reject all"]',
    '[jsname="b3VHJd"]',
    '.tHlp8d button',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) await el.click();
    } catch {
      // ignore
    }
  }
}

// --- Duration parsing ---

function parseDurationHours(durationStr) {
  if (!durationStr) return null;
  const hrMatch = durationStr.match(/(\d+)\s*hr/);
  const minMatch = durationStr.match(/(\d+)\s*min/);
  const hours = hrMatch ? parseInt(hrMatch[1]) : 0;
  const minutes = minMatch ? parseInt(minMatch[1]) : 0;
  return hours + minutes / 60;
}

// --- Scraping ---

async function extractFlightsFromScreenshot(screenshot, route) {
  const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
  const currency = route.currency ?? "USD";

  const prompt =
    `You are extracting flight data from a Google Flights screenshot.\n` +
    `Return ONLY a valid JSON array of flight objects visible on screen. No explanation, no markdown.\n\n` +
    `Each object must have exactly these fields:\n` +
    `- price: number (${currency}, integer, digits only — e.g. 5763)\n` +
    `- airline: string\n` +
    `- duration: string (e.g. "14 hr 30 min")\n` +
    `- stops: number (0 for nonstop, 1 for one stop, etc.)\n` +
    `- depTime: string (e.g. "9:00 PM")\n` +
    `- arrTime: string (e.g. "11:45 AM")\n\n` +
    `If a field is not visible, use null. Skip any row that has no price.`;

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: screenshot.toString("base64") },
        },
        { type: "text", text: prompt },
      ],
    }],
  });

  const text = response.content[0].text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    log(`Claude extraction failed to parse JSON. Raw: ${text.slice(0, 300)}`);
    return [];
  }
}

async function scrapeFlights(route) {
  const url = buildUrl(route);
  log(`[${route.name}] Fetching: ${url}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/Sao_Paulo",
      viewport: { width: 1280, height: 1600 },
      deviceScaleFactor: 2,
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissPopups(page);

    try {
      await page.waitForSelector("li[jsname='pbdLld'], li.pIav2d", { timeout: 30000 });
    } catch {
      log(`[${route.name}] Timed out waiting for flight cards — continuing`);
    }

    await page.waitForTimeout(3000);

    // Scroll down slowly to trigger lazy-loading of cheaper flights
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let pos = 0;
        const step = 600;
        const interval = setInterval(() => {
          window.scrollBy(0, step);
          pos += step;
          if (pos >= document.body.scrollHeight) {
            clearInterval(interval);
            resolve();
          }
        }, 300);
      });
    });
    await page.waitForTimeout(2000);

    const screenshot = await page.screenshot({ fullPage: true });
    log(`[${route.name}] Screenshot captured, sending to Claude...`);

    const flights = await extractFlightsFromScreenshot(screenshot, route);
    log(`[${route.name}] Claude extracted ${flights.length} flight(s)`);

    // Apply filters
    const maxStops = route.maxStops ?? null;
    const maxDurationHours = route.maxDurationHours ?? null;

    const filtered = flights.filter((f) => {
      if (!f.price || isNaN(f.price) || f.price < 100) return false;
      if (maxStops !== null && f.stops !== null && f.stops > maxStops) return false;
      if (maxDurationHours !== null) {
        const h = parseDurationHours(f.duration);
        if (h === null || h > maxDurationHours) return false;
      }
      return true;
    });

    filtered.sort((a, b) => a.price - b.price);
    return filtered.slice(0, 5);
  } finally {
    await browser.close();
  }
}

// --- Telegram ---

async function sendTelegram(token, chatId, message) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      log(`Telegram error ${res.status}: ${body}`);
    } else {
      log("Telegram alert sent successfully");
    }
  } catch (e) {
    log(`Telegram send failed: ${e.message}`);
  }
}

// --- Message formatting ---

function formatDateLabel(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatMessage(route, flight, alertType) {
  const emoji = { first: "🟢", lower: "📉", returned: "🔁" }[alertType];
  const stopsLabel = flight.stops === 0 ? "Nonstop" : `${flight.stops} stop${flight.stops > 1 ? "s" : ""}`;
  const currency = route.currency ?? "USD";
  const priceFormatted = flight.price.toLocaleString("pt-BR");

  const depLabel = formatDateLabel(route.departureDate);
  const retLabel = route.returnDate ? formatDateLabel(route.returnDate) : null;
  const dateStr = route.roundTrip && retLabel ? `${depLabel} → ${retLabel}` : depLabel;

  const timeStr =
    flight.depTime && flight.arrTime
      ? `${flight.depTime} → ${flight.arrTime}  (${flight.duration})`
      : flight.duration ?? "N/A";

  const searchLink = buildUrl(route);

  return (
    `${emoji} Good price found — ${route.name}\n\n` +
    `✈️  ${flight.airline ?? "Unknown airline"}  ·  ${stopsLabel}\n` +
    `📅  ${dateStr}\n` +
    `🕐  ${timeStr}\n` +
    `💰  ${currency} ${priceFormatted}\n\n` +
    `🔗 [Search on Google Flights](${searchLink})`
  );
}

// --- Alert logic ---

function evaluateAlert(route, best, state) {
  const maxBudget = route.maxBudget ?? null;

  // Backwards compat: no maxBudget configured
  if (maxBudget === null) {
    const lastSeen = state?.lastSeenPrice ?? null;
    if (lastSeen === null || best.price < lastSeen) {
      return "first";
    }
    return null;
  }

  if (best.price > maxBudget) {
    return null; // silent — above budget
  }

  // Price is at or under budget
  const lastAlertPrice = state?.lastAlertPrice ?? null;
  if (lastAlertPrice === null) {
    return "first";
  } else if (best.price < lastAlertPrice) {
    return "lower";
  } else if (best.price === lastAlertPrice) {
    return null; // no change
  } else {
    return "returned"; // best.price > lastAlertPrice but still <= maxBudget
  }
}

// --- Main run loop ---

async function run(config) {
  log("=== Bot run started ===");
  const prices = loadPrices();

  const activeRoutes = config.routes.filter((r) => {
    if (!r.active) {
      log(`[${r.name}] Skipped (inactive)`);
      return false;
    }
    return true;
  });

  for (let i = 0; i < activeRoutes.length; i++) {
    const route = activeRoutes[i];
    log(`[${route.name}] Checking...`);

    const variants = dateVariants(route);

    // Scrape variants sequentially to avoid bot detection and resource exhaustion
    const variantResults = [];
    for (const variant of variants) {
      const label = variant._dateLabel ? ` (${variant._dateLabel})` : "";
      log(`[${route.name}]${label} Scraping...`);
      try {
        const results = await scrapeFlights(variant);
        log(`[${route.name}]${label} Found ${results.length} result(s)`);
        for (const r of results) r._variant = variant;
        variantResults.push(results);
      } catch (e) {
        log(`[${route.name}]${label} Scrape error: ${e.message}`);
        variantResults.push([]);
      }
      // Random delay between requests to avoid bot detection
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 3000));
    }

    const allResults = variantResults.flat();

    if (allResults.length === 0) {
      log(`[${route.name}] No results across all date variants, skipping`);
      continue;
    }

    allResults.sort((a, b) => a.price - b.price);
    const best = allResults[0];
    log(`[${route.name}] Best price: ${best.price}`);

    const state = prices[route.name] ?? null;
    const alertType = evaluateAlert(route, best, state);
    const now = new Date().toISOString();

    if (alertType !== null) {
      log(`[${route.name}] Alert type: ${alertType}, price: ${best.price}`);
      prices[route.name] = {
        ...(state ?? {}),
        lastAlertPrice: best.price,
        lastAlertAt: now,
        lastSeenPrice: best.price,
        lastSeenAt: now,
      };
      savePrices(prices);
      logAlert(route, best, alertType);

      const bestRoute = best._variant ?? route;
      const message = formatMessage(bestRoute, best, alertType);
      await sendTelegram(config.telegram.token, config.telegram.chatId, message);
    } else {
      log(`[${route.name}] No alert (price: ${best.price}, lastAlertPrice: ${state?.lastAlertPrice ?? "none"})`);
      prices[route.name] = {
        ...(state ?? {}),
        lastSeenPrice: best.price,
        lastSeenAt: now,
      };
      savePrices(prices);
    }

    // Rate limiting between routes
    if (i < activeRoutes.length - 1) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  log("=== Bot run complete ===");
}

// --- Entry point ---

const config = loadConfig();

cron.schedule(config.schedule, () => {
  run(config).catch((e) => log(`Run failed: ${e.message}`));
});

log(`Bot started. Schedule: ${config.schedule}`);
run(config).catch((e) => log(`Initial run failed: ${e.message}`));
