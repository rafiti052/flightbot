import cron from "node-cron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildUrl,
  captureFlightsScreenshot,
  extractFlightsFromScreenshot,
  filterFlights,
} from "./scraper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, ".env");
const CONFIG_PATH = path.join(__dirname, "config.json");
const PRICES_PATH = path.join(__dirname, "prices.json");
const LOG_PATH = path.join(__dirname, "results.log");

try {
  process.loadEnvFile(ENV_PATH);
} catch {
  // No .env file present — fall back to env vars injected by the environment (e.g. Docker).
}
const RUN_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

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
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config.json is malformed JSON: ${e.message}`);
  }

  const anthropicKey = process.env.ANTHROPIC_KEY;
  const telegramKey = process.env.TELEGRAM_KEY;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  if (!anthropicKey) throw new Error("ANTHROPIC_KEY is not set (check .env)");
  if (!telegramKey) throw new Error("TELEGRAM_KEY is not set (check .env)");
  if (!telegramChatId) throw new Error("TELEGRAM_CHAT_ID is not set (check .env)");

  config.anthropic = { ...config.anthropic, apiKey: anthropicKey };
  config.telegram = { ...config.telegram, token: telegramKey, chatId: telegramChatId };

  return config;
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
  try {
    console.log(line);
  } catch {
    // Ignore console failures so we can still attempt file logging.
  }
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch (e) {
    try {
      console.error(`[flightbot] Failed to append to ${LOG_PATH}: ${e.message}`);
    } catch {
      // Ignore secondary logging failures.
    }
  }
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
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
  } catch (e) {
    log(`Failed to append alert record: ${e.message}`);
  }
}

function formatError(err) {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
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

// --- Scraping ---

async function scrapeFlights(route, apiKey) {
  const screenshot = await captureFlightsScreenshot(route, {
    log: (msg) => log(`[${route.name}] ${msg}`),
  });
  log(`[${route.name}] Screenshot captured, sending to Claude...`);

  const { flights, rawText, parseError } = await extractFlightsFromScreenshot(screenshot, route, apiKey);
  if (parseError) {
    log(`[${route.name}] Claude extraction failed to parse JSON. Raw: ${rawText.slice(0, 300)}`);
  }
  log(`[${route.name}] Claude extracted ${flights.length} flight(s)`);

  // maxBudget is intentionally not applied here — evaluateAlert() needs to see
  // over-budget prices to track lastSeenPrice.
  const filtered = filterFlights(flights, {
    maxStops: route.maxStops ?? null,
    maxDurationHours: route.maxDurationHours ?? null,
  });

  filtered.sort((a, b) => a.price - b.price);
  return filtered.slice(0, 5);
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
        const results = await scrapeFlights(variant, config.anthropic.apiKey);
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

let runState = {
  inProgress: false,
  startedAt: 0,
};

async function runWithLock(config, trigger) {
  const now = Date.now();
  if (runState.inProgress) {
    const ageMs = now - runState.startedAt;
    if (ageMs < RUN_LOCK_STALE_MS) {
      log(`Skipping ${trigger} run because another run is still active (${Math.round(ageMs / 1000)}s old)`);
      return;
    }
    log(`Previous run lock was stale after ${Math.round(ageMs / 1000)}s; forcing a new ${trigger} run`);
  }

  runState = { inProgress: true, startedAt: now };
  try {
    await run(config);
  } catch (e) {
    log(`${trigger === "startup" ? "Initial" : "Scheduled"} run failed: ${formatError(e)}`);
  } finally {
    runState = { inProgress: false, startedAt: 0 };
  }
}

// --- Entry point ---

const config = loadConfig();

cron.schedule(config.schedule, () => {
  const freshConfig = loadConfig();
  runWithLock(freshConfig, "schedule");
});

log(`Bot started. Schedule: ${config.schedule}`);

process.on("unhandledRejection", (reason) => {
  log(`Unhandled rejection: ${formatError(reason)}`);
});

process.on("uncaughtException", (error) => {
  log(`Uncaught exception: ${formatError(error)}`);
});

// Run once on startup so a deploy is verifiable without waiting for the next cron tick.
runWithLock(config, "startup");
