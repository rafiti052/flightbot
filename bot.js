import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  migrateJsonToYamlIfNeeded,
  readFlightbotConfig,
  writeFlightbotConfigAtomic,
  stripInternalConfigFields,
  writeLastRunMarker,
  ConfigRevisionConflict,
} from "@flightbot/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.FLIGHTBOT_DATA_DIR || __dirname;
const PRICES_PATH = path.join(DATA_DIR, "prices.json");
const LOG_PATH = path.join(DATA_DIR, "results.log");

(() => {
  const m = migrateJsonToYamlIfNeeded(DATA_DIR);
  if (m.migrated && m.message) {
    console.log(`[flightbot] ${m.message}`);
  }
})();
const ANTHROPIC_TIMEOUT_MS = 120_000;
const ANTHROPIC_MAX_RETRIES = 1;
const SCRAPE_TIMEOUT_MS = 180_000;
const MAX_SCROLL_STEPS = 20;
const RUN_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

// --- Config loading ---

function loadConfig() {
  const { config } = readFlightbotConfig(DATA_DIR);
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

function readLogLines() {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    const raw = fs.readFileSync(LOG_PATH, "utf-8");
    return raw.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function readRecentLogLines(maxLines = 400) {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    const raw = fs.readFileSync(LOG_PATH, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length <= maxLines) return lines;
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
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

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

async function extractFlightsFromScreenshot(screenshot, route, apiKey) {
  const anthropic = new Anthropic({
    apiKey,
    timeout: ANTHROPIC_TIMEOUT_MS,
    maxRetries: ANTHROPIC_MAX_RETRIES,
  });
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

async function scrapeFlights(route, apiKey) {
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
    return await withTimeout((async () => {
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
    await page.evaluate(async (maxSteps) => {
      const step = 600;
      for (let i = 0; i < maxSteps; i++) {
        const before = window.scrollY;
        window.scrollBy(0, step);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const after = window.scrollY;
        const maxScroll = Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
        ) - window.innerHeight;
        if (after === before || after >= maxScroll) break;
      }
    }, MAX_SCROLL_STEPS);
    await page.waitForTimeout(2000);

    const screenshot = await page.screenshot({ fullPage: true });
    log(`[${route.name}] Screenshot captured, sending to Claude...`);

    const flights = await extractFlightsFromScreenshot(screenshot, route, apiKey);
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
    })(), SCRAPE_TIMEOUT_MS, `[${route.name}] scrape`);
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

function getVariantScrapeCount(route) {
  return dateVariants(route).length;
}

function normalizePriceState(state) {
  if (!state || typeof state !== "object") {
    return {
      hasHistory: false,
      lastSeenPrice: null,
      lastSeenAt: null,
      lastAlertPrice: null,
      lastAlertAt: null,
    };
  }

  return {
    hasHistory: state.lastSeenPrice != null || state.lastAlertPrice != null,
    lastSeenPrice: state.lastSeenPrice ?? null,
    lastSeenAt: state.lastSeenAt ?? null,
    lastAlertPrice: state.lastAlertPrice ?? null,
    lastAlertAt: state.lastAlertAt ?? null,
  };
}

function summarizeRecentLogActivity(lines) {
  const summary = {
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    lastRunStatus: null,
    lastFailureAt: null,
    lastFailureMessage: null,
    lastAlertByRoute: {},
  };

  for (const line of lines) {
    if (line.startsWith("{")) {
      try {
        const record = JSON.parse(line);
        if (record?.route) {
          summary.lastAlertByRoute[record.route] = {
            ts: record.ts ?? null,
            alertType: record.alertType ?? null,
            price: record.price ?? null,
            airline: record.airline ?? null,
            stops: record.stops ?? null,
            duration: record.duration ?? null,
          };
        }
      } catch {
        // Ignore malformed historical log records.
      }
      continue;
    }

    const tsMatch = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!tsMatch) continue;
    const [, ts, message] = tsMatch;

    if (message === "=== Bot run started ===") {
      summary.lastRunStartedAt = ts;
      summary.lastRunStatus = "started";
      continue;
    }

    if (message === "=== Bot run complete ===") {
      summary.lastRunCompletedAt = ts;
      summary.lastRunStatus = "completed";
      continue;
    }

    if (
      message.includes(" run failed:") ||
      message.startsWith("Unhandled rejection:") ||
      message.startsWith("Uncaught exception:")
    ) {
      summary.lastFailureAt = ts;
      summary.lastFailureMessage = message;
      summary.lastRunStatus = "failed";
    }
  }

  return summary;
}

function deriveRouteStateSummary(route, priceState, logSummary) {
  const normalized = normalizePriceState(priceState);
  const lastAlert = logSummary.lastAlertByRoute[route.name] ?? null;
  const trackingMode = route.maxBudget == null ? "new-low" : "budget";

  let status = "unknown";
  if (!route.active) {
    status = "inactive";
  } else if (!normalized.hasHistory) {
    status = "watching";
  } else if (route.maxBudget != null && normalized.lastSeenPrice != null) {
    status = normalized.lastSeenPrice <= route.maxBudget ? "under-budget" : "above-budget";
  } else if (normalized.lastSeenPrice != null) {
    status = "tracking";
  }

  return {
    name: route.name,
    active: !!route.active,
    from: route.from,
    to: route.to,
    roundTrip: !!route.roundTrip,
    departureDate: route.departureDate ?? null,
    returnDate: route.returnDate ?? null,
    flexDays: route.flexDays ?? 0,
    variantChecksPerRun: getVariantScrapeCount(route),
    trackingMode,
    maxBudget: route.maxBudget ?? null,
    currency: route.currency ?? "USD",
    maxStops: route.maxStops ?? null,
    maxDurationHours: route.maxDurationHours ?? null,
    status,
    ...normalized,
    lastAlert: lastAlert ?? {
      ts: normalized.lastAlertAt,
      alertType: null,
      price: normalized.lastAlertPrice,
      airline: null,
      stops: null,
      duration: null,
    },
  };
}

function parseIsoDateSafe(value) {
  if (typeof value !== "string" || !value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function parseBracketedLogLine(line) {
  const tsMatch = line.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!tsMatch) return null;
  const [, tsRaw, messageRaw] = tsMatch;
  const ts = parseIsoDateSafe(tsRaw);
  const message = String(messageRaw ?? "").trim();
  if (!ts || !message) return null;

  const routeMatch = message.match(/^\[([^\]]+)\]\s*(.*)$/);
  const route = routeMatch ? routeMatch[1] : null;
  const cleanMessage = routeMatch ? routeMatch[2] : message;
  const messageLower = cleanMessage.toLowerCase();

  if (
    messageLower.includes("fetching:") ||
    messageLower.includes("scraping...") ||
    messageLower.includes("screenshot captured")
  ) {
    return null;
  }

  let event = "run";
  if (message === "=== Bot run started ===") event = "run-started";
  else if (message === "=== Bot run complete ===") event = "run-complete";
  else if (messageLower.includes("run failed:") || messageLower.startsWith("unhandled rejection:") || messageLower.startsWith("uncaught exception:")) event = "run-failed";
  else if (messageLower.includes("alert type:")) event = "alert-triggered";
  else if (messageLower.includes("no alert")) event = "no-alert";
  else if (messageLower.includes("scrape error:")) event = "scrape-error";

  return {
    ts,
    event,
    route,
    message: cleanMessage,
  };
}

function parseAlertLogLine(line) {
  if (!line.startsWith("{")) return null;
  try {
    const record = JSON.parse(line);
    if (!record || typeof record !== "object") return null;
    const ts = parseIsoDateSafe(record.ts);
    if (!ts || !record.route) return null;

    return {
      ts,
      event: "alert-recorded",
      route: String(record.route),
      alertType: record.alertType ?? null,
      price: typeof record.price === "number" ? record.price : null,
      airline: typeof record.airline === "string" ? record.airline : null,
      stops: Number.isInteger(record.stops) ? record.stops : null,
      duration: typeof record.duration === "string" ? record.duration : null,
      message: `Alert ${record.alertType ?? "recorded"} at price ${record.price ?? "n/a"}`,
    };
  } catch {
    return null;
  }
}

function buildRecentActivity(lines, maxItems = 24) {
  const events = [];
  for (let i = lines.length - 1; i >= 0 && events.length < maxItems; i -= 1) {
    const line = lines[i];
    const event = parseAlertLogLine(line) ?? parseBracketedLogLine(line);
    if (!event) continue;
    events.push(event);
  }
  return events;
}

function buildStatusReadModel() {
  const config = loadConfig();
  const prices = loadPrices();
  const logLines = readLogLines();
  const recentLogLines = readRecentLogLines();
  const logSummary = summarizeRecentLogActivity(logLines);
  const recentActivity = buildRecentActivity(recentLogLines);
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const activeRoutes = routes.filter((route) => route.active);
  const routeSummaries = routes.map((route) => deriveRouteStateSummary(route, prices[route.name], logSummary));
  const activeVariantChecksPerRun = activeRoutes.reduce((sum, route) => sum + getVariantScrapeCount(route), 0);

  return {
    generatedAt: new Date().toISOString(),
    runtime: {
      inProgress: runState.inProgress,
      startedAt: runState.startedAt ? new Date(runState.startedAt).toISOString() : null,
      activeRunAgeMs: runState.inProgress ? Date.now() - runState.startedAt : 0,
      lockStaleAfterMs: RUN_LOCK_STALE_MS,
    },
    schedule: {
      expression: config.schedule ?? null,
      valid: typeof config.schedule === "string" ? cron.validate(config.schedule) : false,
      timezone: "America/Sao_Paulo",
      lastRunStartedAt: logSummary.lastRunStartedAt,
      lastRunCompletedAt: logSummary.lastRunCompletedAt,
      lastRunStatus: logSummary.lastRunStatus,
      lastFailureAt: logSummary.lastFailureAt,
      lastFailureMessage: logSummary.lastFailureMessage,
    },
    routes: {
      totalCount: routes.length,
      activeCount: activeRoutes.length,
      inactiveCount: routes.length - activeRoutes.length,
      activeVariantChecksPerRun,
    },
    recentActivity,
    routeSummaries,
  };
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
  let runFailed = false;
  let runErrorText = null;
  try {
    await run(config);
  } catch (e) {
    runFailed = true;
    runErrorText = formatError(e);
    log(`${trigger === "startup" ? "Initial" : "Scheduled"} run failed: ${runErrorText}`);
  } finally {
    runState = { inProgress: false, startedAt: 0 };
    try {
      writeLastRunMarker(DATA_DIR, {
        status: runFailed ? "error" : "ok",
        error: runFailed ? runErrorText : null,
      });
    } catch (e2) {
      log(`Failed to write last-run marker: ${e2.message}`);
    }
  }
}

// --- Config API helpers ---

function maskConfig(config) {
  return {
    ...config,
    anthropic: { ...config.anthropic, apiKey: "••••••" },
    telegram: { ...config.telegram, token: "••••••" },
  };
}

function deepMergePreservingSensitive(incoming, onDisk) {
  return {
    ...onDisk,
    ...incoming,
    anthropic: { ...onDisk.anthropic },
    telegram: {
      ...onDisk.telegram,
      chatId: incoming.telegram?.chatId ?? onDisk.telegram.chatId,
    },
  };
}

function writeConfigAtomic(config, options = {}) {
  writeFlightbotConfigAtomic(DATA_DIR, config, options);
}

// --- UI HTML ---

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Flightbot Ops</title>
<style>
  :root {
    --bg: #eff4f8;
    --bg-accent: #dfeaf1;
    --surface: rgba(255, 255, 255, 0.92);
    --surface-strong: #ffffff;
    --surface-dark: #0f2538;
    --text: #123047;
    --muted: #5f7385;
    --line: rgba(17, 43, 65, 0.1);
    --primary: #0b6aa2;
    --primary-strong: #0a4f79;
    --success: #178a5f;
    --warning: #c47b18;
    --danger: #c74c3c;
    --shadow: 0 10px 26px rgba(15, 37, 56, 0.06);
    --shadow-soft: 0 1px 0 rgba(15, 37, 56, 0.04), 0 8px 20px rgba(15, 37, 56, 0.05);
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Inter, "Segoe UI", Roboto, sans-serif;
    color: var(--text);
    min-height: 100vh;
    background:
      radial-gradient(circle at top left, rgba(32, 125, 173, 0.18), transparent 30%),
      radial-gradient(circle at top right, rgba(14, 98, 130, 0.12), transparent 26%),
      linear-gradient(180deg, #f5f9fc 0%, #edf3f7 58%, #eef4f8 100%);
  }

  header {
    position: sticky;
    top: 0;
    z-index: 20;
    backdrop-filter: blur(14px);
    background: rgba(245, 249, 252, 0.82);
    border-bottom: 1px solid rgba(18, 48, 71, 0.08);
  }

  .topbar {
    max-width: 1220px;
    margin: 0 auto;
    padding: 18px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .brand-badge {
    width: 42px;
    height: 42px;
    border-radius: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    background: linear-gradient(145deg, #0b6aa2 0%, #0f8c9c 100%);
    box-shadow: 0 14px 28px rgba(11, 106, 162, 0.28);
  }

  .brand-badge svg { width: 22px; height: 22px; }
  .brand-copy { display: flex; flex-direction: column; gap: 2px; }
  .brand-title { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; }
  .brand-subtitle { font-size: 12px; color: var(--muted); font-weight: 500; letter-spacing: 0.02em; }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .header-health {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    border: 1px solid rgba(18, 48, 71, 0.1);
    background: rgba(255, 255, 255, 0.78);
    color: var(--muted);
    white-space: nowrap;
  }

  .header-health-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 42px;
    padding: 0 18px;
    border-radius: 10px;
    border: 1px solid transparent;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: transform .16s ease, box-shadow .16s ease, background .16s ease, border-color .16s ease, color .16s ease;
  }

  .btn:hover { transform: translateY(-1px); }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn-primary {
    color: #fff;
    background: linear-gradient(135deg, #0b6aa2 0%, #0f8c9c 100%);
    box-shadow: 0 14px 24px rgba(11, 106, 162, 0.24);
  }
  .btn-primary:hover { box-shadow: 0 16px 28px rgba(11, 106, 162, 0.3); }
  .btn-ghost {
    color: var(--text);
    background: rgba(255, 255, 255, 0.72);
    border-color: rgba(18, 48, 71, 0.1);
  }
  .btn-ghost:hover { background: rgba(255, 255, 255, 0.96); }
  .btn-danger {
    color: var(--danger);
    background: rgba(255, 243, 240, 0.9);
    border-color: rgba(199, 76, 60, 0.18);
  }
  .btn-danger:hover { background: #fff3f0; }
  .btn.small { min-height: 36px; padding: 0 14px; font-size: 13px; border-radius: 12px; }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
    border: 1px solid transparent;
    white-space: nowrap;
  }

  .pill.info { color: #0b6aa2; background: rgba(11, 106, 162, 0.1); border-color: rgba(11, 106, 162, 0.16); }
  .pill.success { color: var(--success); background: rgba(23, 138, 95, 0.1); border-color: rgba(23, 138, 95, 0.16); }
  .pill.warning { color: var(--warning); background: rgba(196, 123, 24, 0.12); border-color: rgba(196, 123, 24, 0.18); }
  .pill.danger { color: var(--danger); background: rgba(199, 76, 60, 0.1); border-color: rgba(199, 76, 60, 0.16); }
  .pill.neutral { color: var(--muted); background: rgba(95, 115, 133, 0.1); border-color: rgba(95, 115, 133, 0.14); }
  .pill.dark { color: #e5f5ff; background: rgba(10, 33, 51, 0.52); border-color: rgba(214, 235, 249, 0.16); }

  main {
    max-width: 1220px;
    margin: 0 auto;
    padding: 28px 24px 48px;
    display: grid;
    gap: 24px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow-soft);
  }

  .dashboard-section {
    display: grid;
    gap: 14px;
  }

  .section-kicker {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--muted);
  }

  .side-panel {
    padding: 0;
  }

  .settings-panel {
    display: grid;
    gap: 14px;
  }

  .settings-panel summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    user-select: none;
  }

  .settings-panel summary::-webkit-details-marker { display: none; }

  .settings-summary-copy {
    display: grid;
    gap: 4px;
  }

  .settings-summary-title {
    font-size: 13px;
    font-weight: 650;
    letter-spacing: 0.02em;
    color: var(--muted);
  }

  .settings-summary-subtitle {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .settings-summary-state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    color: var(--text);
    background: rgba(18, 48, 71, 0.05);
    border: 1px solid rgba(18, 48, 71, 0.08);
    white-space: nowrap;
  }

  .settings-panel[open] .settings-summary-state {
    background: rgba(11, 106, 162, 0.08);
    color: var(--primary);
    border-color: rgba(11, 106, 162, 0.16);
  }

  .settings-body {
    padding: 0 18px 18px;
    display: grid;
    gap: 12px;
  }

  .schedule-block {
    display: grid;
    gap: 9px;
  }

  .schedule-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
  }

  .schedule-input-wrap {
    display: grid;
    gap: 8px;
  }

  .schedule-guided-grid {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .schedule-guided-field {
    display: grid;
    gap: 6px;
  }

  .schedule-guided-field label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--muted);
  }

  .schedule-guided-summary {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .schedule-input {
    width: 100%;
    min-height: 40px;
    padding: 0 14px;
    border-radius: 10px;
    border: 1px solid rgba(18, 48, 71, 0.12);
    background: rgba(248, 251, 253, 0.92);
    color: var(--text);
    font-size: 14px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    outline: none;
    transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
  }

  .schedule-input:focus {
    border-color: rgba(11, 106, 162, 0.55);
    box-shadow: 0 0 0 4px rgba(11, 106, 162, 0.12);
    background: #fff;
  }

  .support-text {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.45;
  }

  .schedule-meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .schedule-mini {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .info-list { display: grid; gap: 12px; }
  .info-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .info-row-label { font-size: 12px; color: var(--muted); font-weight: 500; letter-spacing: 0.02em; }
  .info-row-value { font-size: 14px; font-weight: 600; text-align: right; }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .ops-grid {
    display: grid;
    grid-template-columns: minmax(300px, 0.95fr) minmax(0, 1.35fr);
    gap: 16px;
    align-items: start;
  }

  .summary-card {
    padding: 12px 14px 11px;
    display: grid;
    gap: 8px;
  }

  .summary-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .summary-label {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--muted);
  }

  .summary-value {
    font-size: 21px;
    line-height: 1;
    font-weight: 760;
    letter-spacing: -0.04em;
  }

  .summary-copy {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }

  .summary-list {
    display: grid;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }

  .summary-list strong { color: var(--text); font-weight: 700; }

  .section-heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }

  .section-title {
    font-size: 22px;
    font-weight: 740;
    letter-spacing: -0.03em;
  }

  .section-subtitle {
    margin-top: 4px;
    color: var(--muted);
    font-size: 14px;
  }

  .routes-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .route-card {
    padding: 15px 15px 14px;
    display: grid;
    gap: 12px;
    transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease, opacity .16s ease;
  }

  .route-card:hover {
    transform: translateY(-1px);
    border-color: rgba(11, 106, 162, 0.14);
    box-shadow: var(--shadow);
  }

  .route-card.status-under-budget {
    border-color: rgba(23, 138, 95, 0.32);
    box-shadow: 0 1px 0 rgba(23, 138, 95, 0.06), 0 10px 24px rgba(15, 37, 56, 0.05);
  }

  .route-card.status-above-budget {
    border-color: rgba(196, 123, 24, 0.22);
  }

  .route-card.inactive {
    opacity: 0.84;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(245, 249, 252, 0.9));
  }

  .route-fare-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .route-fare-hero {
    min-width: 0;
    flex: 1;
  }

  .route-fare-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--muted);
  }

  .route-fare-value {
    margin-top: 4px;
    font-size: 28px;
    line-height: 1.08;
    font-weight: 780;
    letter-spacing: -0.04em;
    color: var(--surface-dark);
  }

  .route-fare-value.fare-under {
    color: var(--success);
  }

  .route-fare-value.fare-over {
    color: var(--warning);
  }

  .route-fare-spotlight {
    padding: 12px 14px;
    border-radius: 10px;
    background: rgba(242, 248, 252, 0.85);
    border: 1px solid rgba(18, 48, 71, 0.07);
  }

  .route-fare-spotlight .route-fare-value {
    font-size: 32px;
    margin-top: 6px;
  }

  .route-metrics {
    display: grid;
    gap: 12px;
  }

  .route-metrics-secondary {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    align-items: start;
  }

  .route-fare-sub {
    margin-top: 5px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.4;
  }

  .route-card.inactive .route-fare-value {
    opacity: 0.78;
  }

  .route-identity-primary {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .route-airports {
    display: inline-flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px 10px;
    font-size: 21px;
    font-weight: 750;
    letter-spacing: -0.03em;
    color: var(--text);
    line-height: 1.15;
  }

  .route-arrow {
    opacity: 0.42;
    font-weight: 600;
    font-size: 0.92em;
  }

  .route-trip-subtitle {
    font-size: 12px;
    font-weight: 500;
    color: var(--muted);
    line-height: 1.35;
  }

  .route-name { font-size: 16px; font-weight: 750; letter-spacing: -0.02em; color: var(--text); }
  .route-name.hidden { display: none; }

  .route-meta-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--muted);
  }

  .route-legs {
    font-weight: 650;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .route-meta-sep {
    opacity: 0.45;
    font-weight: 600;
  }

  .route-status-group { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; flex-shrink: 0; }

  .route-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .route-body {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
  }

  .route-journey { flex: 1; min-width: 0; display: grid; gap: 6px; }

  .route-date-line {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .toggle-stack {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
  }

  .route-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .route-control-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }

  .route-control-actions {
    display: grid;
    justify-items: end;
    gap: 9px;
  }

  .route-filter-line {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px;
    border-radius: 999px;
    background: rgba(11, 106, 162, 0.08);
    color: var(--primary);
    font-size: 12px;
    font-weight: 700;
  }

  .toggle {
    position: relative;
    width: 50px;
    height: 28px;
  }

  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-track {
    position: absolute;
    inset: 0;
    border-radius: 999px;
    background: rgba(95, 115, 133, 0.3);
    border: 1px solid rgba(95, 115, 133, 0.22);
    cursor: pointer;
    transition: background .18s ease, border-color .18s ease;
  }
  .toggle input:checked + .toggle-track {
    background: rgba(11, 106, 162, 0.86);
    border-color: rgba(11, 106, 162, 0.86);
  }
  .toggle-thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 8px 18px rgba(15, 37, 56, 0.22);
    transition: transform .18s ease;
    pointer-events: none;
  }
  .toggle input:checked ~ .toggle-thumb { transform: translateX(22px); }

  .icon-row { display: flex; gap: 8px; }
  .icon-btn {
    width: 38px;
    height: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    border: 1px solid rgba(18, 48, 71, 0.08);
    background: rgba(255, 255, 255, 0.78);
    color: var(--muted);
    cursor: pointer;
    transition: background .16s ease, color .16s ease, border-color .16s ease;
  }
  .icon-btn:hover { color: var(--text); background: #fff; border-color: rgba(11, 106, 162, 0.18); }
  .icon-btn.delete:hover { color: var(--danger); border-color: rgba(199, 76, 60, 0.2); background: #fff3f0; }

  .route-secondary-metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    align-items: start;
    padding: 10px 12px;
    border-radius: 16px;
    background: rgba(242, 248, 252, 0.9);
    border: 1px solid rgba(18, 48, 71, 0.06);
  }

  .metric-card {
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-content: start;
  }

  .metric-label {
    font-size: 11px;
    color: var(--muted);
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .metric-value {
    font-size: 14px;
    font-weight: 730;
    letter-spacing: -0.03em;
    color: var(--surface-dark);
  }

  .metric-sub {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.45;
  }

  .route-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    border-top: 1px solid rgba(18, 48, 71, 0.08);
    padding-top: 9px;
  }

  .route-footer-copy {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
    font-weight: 500;
  }

  .route-footer-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
  }

  .route-footer-note {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--muted);
  }

  .route-footer-note strong {
    color: var(--text);
    font-weight: 700;
  }

  .route-badge-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    align-items: center;
  }

  .pill.compact {
    padding: 4px 9px;
    font-size: 10px;
    font-weight: 700;
  }

  .pill.subtle {
    color: var(--muted);
    background: rgba(95, 115, 133, 0.06);
    border-color: rgba(95, 115, 133, 0.1);
  }

  .pill.soft-info {
    color: #0b6aa2;
    background: rgba(11, 106, 162, 0.06);
    border-color: rgba(11, 106, 162, 0.1);
  }

  .empty-card {
    padding: 34px;
    text-align: center;
    color: var(--muted);
    background: rgba(255,255,255,0.84);
  }

  .activity-card {
    padding: 12px;
    display: grid;
    gap: 10px;
    background: linear-gradient(180deg, rgba(250, 253, 255, 0.96) 0%, rgba(246, 251, 254, 0.92) 100%);
    border-color: rgba(18, 48, 71, 0.08);
  }

  .activity-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .activity-title { font-size: 13px; font-weight: 720; letter-spacing: -0.01em; }

  .activity-subtitle {
    margin-top: 3px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  .activity-list {
    list-style: none;
    display: grid;
    gap: 6px;
  }

  .activity-item {
    display: grid;
    gap: 5px;
    padding: 8px 10px;
    border-radius: 12px;
    border: 1px solid rgba(18, 48, 71, 0.07);
    background: rgba(255, 255, 255, 0.84);
  }

  .activity-item.priority-alert {
    border-color: rgba(23, 138, 95, 0.25);
    background: linear-gradient(180deg, rgba(237, 251, 245, 0.88) 0%, rgba(248, 253, 250, 0.92) 100%);
  }

  .activity-item.alert-lower {
    border-color: rgba(11, 106, 162, 0.28);
    background: linear-gradient(180deg, rgba(234, 246, 253, 0.9) 0%, rgba(247, 252, 255, 0.94) 100%);
  }

  .activity-item.alert-returned {
    border-color: rgba(196, 123, 24, 0.24);
    background: linear-gradient(180deg, rgba(255, 248, 236, 0.88) 0%, rgba(255, 252, 247, 0.93) 100%);
  }

  .activity-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .activity-message {
    font-size: 12px;
    color: var(--text);
    line-height: 1.35;
    font-weight: 600;
  }

  .activity-pill-row {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }

  .activity-pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.02em;
    border: 1px solid rgba(18, 48, 71, 0.12);
    color: #355266;
    background: rgba(95, 115, 133, 0.08);
  }

  .activity-pill.route {
    color: #0b6aa2;
    background: rgba(11, 106, 162, 0.08);
    border-color: rgba(11, 106, 162, 0.14);
  }

  .activity-pill.event {
    color: #476177;
    background: rgba(95, 115, 133, 0.1);
    border-color: rgba(95, 115, 133, 0.14);
  }

  .activity-pill.metric {
    color: #0e7f60;
    background: rgba(23, 138, 95, 0.1);
    border-color: rgba(23, 138, 95, 0.16);
  }

  .activity-pill.outcome {
    color: #0e7f60;
    background: rgba(23, 138, 95, 0.12);
    border-color: rgba(23, 138, 95, 0.22);
  }

  .activity-pill.outcome.lower {
    color: #0b6aa2;
    background: rgba(11, 106, 162, 0.12);
    border-color: rgba(11, 106, 162, 0.22);
  }

  .activity-pill.outcome.returned {
    color: #9a620f;
    background: rgba(196, 123, 24, 0.12);
    border-color: rgba(196, 123, 24, 0.22);
  }

  .activity-pill.outcome.first {
    color: #178a5f;
    background: rgba(23, 138, 95, 0.12);
    border-color: rgba(23, 138, 95, 0.22);
  }

  .activity-empty {
    padding: 10px 11px;
    border-radius: 12px;
    border: 1px dashed rgba(95, 115, 133, 0.26);
    background: rgba(255, 255, 255, 0.7);
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  .activity-time {
    font-size: 10px;
    color: var(--muted);
    white-space: nowrap;
  }

  .overlay {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 100;
    align-items: center;
    justify-content: center;
    background: rgba(9, 24, 37, 0.52);
    backdrop-filter: blur(10px);
    padding: 24px;
  }

  .overlay.open { display: flex; }

  .modal {
    width: min(920px, 100%);
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    padding: 24px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.97);
    border: 1px solid rgba(18, 48, 71, 0.08);
    box-shadow: 0 20px 48px rgba(9, 24, 37, 0.14);
  }

  .modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }

  .modal-title { font-size: 24px; font-weight: 760; letter-spacing: -0.04em; }
  .modal-subtitle { margin-top: 6px; font-size: 13px; color: var(--muted); line-height: 1.5; max-width: 60ch; }

  .modal-sections {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .modal-section {
    padding: 18px;
    border-radius: 12px;
    background: rgba(248, 251, 253, 0.95);
    border: 1px solid rgba(18, 48, 71, 0.07);
    display: grid;
    gap: 14px;
  }

  .modal-section.full { grid-column: 1 / -1; }
  .modal-section-title { font-size: 14px; font-weight: 740; letter-spacing: -0.01em; }
  .modal-section-copy { font-size: 12px; color: var(--muted); line-height: 1.5; }

  .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .form-group { display: grid; gap: 7px; }
  .form-group.full { grid-column: 1 / -1; }
  .form-group label { font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: 0.01em; }
  .form-group input {
    width: 100%;
    min-height: 46px;
    padding: 0 13px;
    border-radius: 10px;
    border: 1px solid rgba(18, 48, 71, 0.12);
    background: #fff;
    color: var(--text);
    font-size: 14px;
    outline: none;
    transition: border-color .16s ease, box-shadow .16s ease;
  }
  .form-group input:focus {
    border-color: rgba(11, 106, 162, 0.55);
    box-shadow: 0 0 0 4px rgba(11, 106, 162, 0.12);
  }
  .form-group input:disabled { background: rgba(238, 244, 247, 0.9); color: #8aa0b0; }

  .field-hint { font-size: 11px; color: #7d92a3; line-height: 1.45; }
  .field-warn {
    display: none;
    font-size: 11px;
    padding: 8px 10px;
    border-radius: 12px;
    background: rgba(255, 238, 209, 0.6);
    color: #9a620f;
  }

  .checkbox-row {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    cursor: pointer;
  }

  .checkbox-row input[type=checkbox] {
    width: 16px;
    height: 16px;
    accent-color: var(--primary);
    cursor: pointer;
  }

  .toggle-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 46px;
    padding: 0 12px;
    border-radius: 14px;
    border: 1px solid rgba(18, 48, 71, 0.1);
    background: #fff;
  }

  .toggle-field-copy {
    display: grid;
    gap: 2px;
  }

  .toggle-field-title {
    font-size: 13px;
    font-weight: 640;
    color: var(--text);
  }

  .toggle-field-subtitle {
    font-size: 11px;
    color: var(--muted);
  }

  .modal-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%) translateY(18px);
    padding: 13px 18px;
    border-radius: 14px;
    background: rgba(15, 37, 56, 0.96);
    color: #fff;
    font-size: 14px;
    box-shadow: 0 18px 36px rgba(15, 37, 56, 0.22);
    opacity: 0;
    transition: opacity .22s ease, transform .22s ease;
    pointer-events: none;
    z-index: 200;
    white-space: nowrap;
  }

  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .toast.error { background: rgba(199, 76, 60, 0.96); }

  @media (max-width: 1080px) {
    .summary-grid,
    .ops-grid,
    .routes-grid,
    .modal-sections {
      grid-template-columns: 1fr;
    }

    .route-secondary-metrics { grid-template-columns: 1fr 1fr; }
  }

  @media (max-width: 760px) {
    .topbar,
    main { padding-left: 16px; padding-right: 16px; }

    .summary-card,
    .route-card,
    .modal { padding: 18px; }

    .settings-body {
      padding: 0 18px 18px;
    }

    .route-secondary-metrics,
    .route-metrics-secondary,
    .form-grid { grid-template-columns: 1fr; }

    .schedule-guided-grid { grid-template-columns: 1fr; }

    .route-control-row {
      justify-content: flex-start;
    }

    .route-control-actions {
      justify-items: start;
    }

    .route-status-group,
    .route-footer-chips {
      justify-content: flex-start;
    }

    .modal-actions,
    .header-actions {
      width: 100%;
      justify-content: stretch;
    }

    .header-actions .btn {
      flex: 1;
      min-width: 0;
    }

    .toast {
      width: calc(100% - 32px);
      text-align: center;
      white-space: normal;
    }
  }
</style>
</head>
<body>
<header>
  <div class="topbar">
    <div class="brand">
      <div class="brand-badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 19.5l7.2-2.2 3.2-3.2 6.7-6.7a2.3 2.3 0 0 0-3.2-3.2l-6.7 6.7-3.2 3.2z"></path>
          <path d="M13 11l4 4"></path>
          <path d="M5 14l5 5"></path>
        </svg>
      </div>
      <div class="brand-copy">
        <div class="brand-title">Flightbot</div>
        <div class="brand-subtitle">Flight ops</div>
      </div>
    </div>
    <div class="header-actions">
      <button class="btn btn-ghost" type="button" onclick="openSettingsModal()" aria-label="Open settings">Settings</button>
      <button type="button" class="btn btn-primary" onclick="openModal()" aria-label="Add monitored trip">Add trip</button>
      <div class="header-health" id="header-health-indicator" title="System health and freshness">
        <span class="header-health-dot" aria-hidden="true"></span>
        <span id="header-health-label">Status pending · Check pending</span>
      </div>
      <span id="dirty-indicator" class="pill warning" style="display:none">Unsaved changes</span>
      <button class="btn btn-ghost" onclick="refreshStatus(true)">Refresh status</button>
      <button class="btn btn-primary" id="save-btn" onclick="saveConfig()" disabled>Save changes</button>
    </div>
  </div>
</header>

<main>
  <section class="dashboard-section">
    <div class="section-heading">
      <div>
        <div class="section-title">Monitored trips</div>
        <div class="section-subtitle">Saved search settings and the latest prices the bot has seen.</div>
      </div>
    </div>
    <section class="routes-grid" id="routes-grid"></section>
  </section>

  <section class="dashboard-section">
    <div class="section-kicker">Recent activity</div>
    <section class="card activity-card" id="activity-card"></section>
  </section>
</main>

<div class="overlay" id="modal-overlay" onclick="closeModalOnBackdrop(event)">
  <div class="modal">
    <div class="modal-header">
      <div>
        <div class="modal-title" id="modal-title">Add trip</div>
        <div class="modal-subtitle">Define trip identity, alert targets, and extraction filters with clearer sections while preserving existing monitoring behavior.</div>
      </div>
      <span class="pill info" id="modal-mode-badge">New trip</span>
    </div>

    <div class="modal-sections">
      <section class="modal-section">
        <div class="modal-section-title">Trip details</div>
        <div class="modal-section-copy">Name this monitored trip, set where it starts/ends, and define the travel dates.</div>
        <div class="form-grid">
          <div class="form-group full">
            <label for="f-name">Trip name</label>
            <input type="text" id="f-name" placeholder="Sao Paulo to Rome spring trip" oninput="onFieldChange()">
            <span class="field-warn" id="warn-rename">Renaming a route resets its price history in prices.json.</span>
          </div>
          <div class="form-group">
            <label for="f-from">From (IATA)</label>
            <input type="text" id="f-from" placeholder="GRU" maxlength="3" oninput="onFieldChange()">
          </div>
          <div class="form-group">
            <label for="f-to">To (IATA)</label>
            <input type="text" id="f-to" placeholder="FCO" maxlength="3" oninput="onFieldChange()">
          </div>
          <div class="form-group">
            <label for="f-departure">Departure date</label>
            <input type="date" id="f-departure" oninput="onFieldChange()">
          </div>
          <div class="form-group">
            <label for="f-return">Return date</label>
            <input type="date" id="f-return" oninput="onFieldChange()">
          </div>
          <div class="form-group full">
            <div class="toggle-field">
              <div class="toggle-field-copy">
                <div class="toggle-field-title">Trip type</div>
                <div class="toggle-field-subtitle">Turn this off for one-way searches.</div>
              </div>
              <label class="checkbox-row">
                <input type="checkbox" id="f-roundtrip" onchange="onRoundTripToggle()">
                Round trip
              </label>
            </div>
            <span class="field-hint">When disabled, return date is ignored.</span>
          </div>
        </div>
      </section>

      <section class="modal-section">
        <div class="modal-section-title">Monitoring targets</div>
        <div class="modal-section-copy">Set how alerts are evaluated and whether this trip is currently monitored.</div>
        <div class="form-grid">
          <div class="form-group">
            <label for="f-currency">Display currency</label>
            <input type="text" id="f-currency" placeholder="BRL" maxlength="3" oninput="onFieldChange()">
          </div>
          <div class="form-group">
            <label for="f-budget">Budget ceiling</label>
            <input type="number" id="f-budget" placeholder="e.g. 7500" oninput="onFieldChange()">
            <span class="field-hint">Leave blank to alert on new lows only.</span>
          </div>
          <div class="form-group">
            <label for="f-flexdays">Flex days</label>
            <input type="number" id="f-flexdays" placeholder="2" min="0" max="7" oninput="onFlexChange()">
            <span class="field-hint">Expands departure day to a ± window.</span>
            <span class="field-warn" id="warn-flex"></span>
          </div>
          <div class="form-group">
            <label for="f-active">Monitoring state</label>
            <div class="toggle-field">
              <div class="toggle-field-copy">
                <div class="toggle-field-title">Include in scheduled runs</div>
                <div class="toggle-field-subtitle">Inactive trips remain saved for later.</div>
              </div>
              <label class="checkbox-row">
                <input type="checkbox" id="f-active" checked onchange="onFieldChange()">
                Active
              </label>
            </div>
          </div>
        </div>
      </section>

      <section class="modal-section full">
        <div class="modal-section-title">Result filters</div>
        <div class="modal-section-copy">These filters are applied after vision extraction, not during Google Flights scraping.</div>
        <div class="form-grid">
          <div class="form-group">
            <label for="f-maxstops">Max stops</label>
            <input type="number" id="f-maxstops" placeholder="1" min="0" oninput="onFieldChange()">
            <span class="field-hint">Use 0 for nonstop only.</span>
          </div>
          <div class="form-group">
            <label for="f-duration">Max duration (hours)</label>
            <input type="number" id="f-duration" placeholder="20" min="1" oninput="onFieldChange()">
            <span class="field-hint">Flights above this duration are filtered out.</span>
          </div>
        </div>
      </section>
    </div>

    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveRoute()">Save route</button>
    </div>
  </div>
</div>

<div class="overlay" id="settings-modal-overlay" onclick="closeSettingsModalOnBackdrop(event)">
  <div class="modal">
    <div class="modal-header">
      <div>
        <div class="modal-title">Settings</div>
        <div class="modal-subtitle" id="settings-summary-subtitle">Cron schedule, run health, and saved config details.</div>
      </div>
      <div class="settings-summary-state" id="settings-summary-state">
        <span class="pill info" id="schedule-live-badge">Live schedule</span>
        <span id="settings-summary-value">Open</span>
      </div>
    </div>
    <div class="modal-sections">
      <section class="modal-section full">
        <div class="modal-section-title">Schedule</div>
        <div class="modal-section-copy">Configure when monitoring runs and keep compatibility with existing cron validation and save flow.</div>
        <div class="schedule-block">
          <label class="schedule-label" for="schedule-mode">Schedule pattern</label>
          <div class="schedule-guided-grid">
            <div class="schedule-guided-field">
              <label for="schedule-mode">Pattern</label>
              <select id="schedule-mode" onchange="onGuidedScheduleChange()">
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="every-hours">Every X hours</option>
                <option value="custom">Custom cron</option>
              </select>
            </div>
            <div class="schedule-guided-field">
              <label for="schedule-time">Run time</label>
              <input type="time" id="schedule-time" value="07:00" onchange="onGuidedScheduleChange()">
            </div>
            <div class="schedule-guided-field">
              <label for="schedule-interval-hours">Interval (hours)</label>
              <input type="number" id="schedule-interval-hours" min="1" max="23" step="1" value="6" onchange="onGuidedScheduleChange()">
            </div>
          </div>
          <div class="schedule-guided-summary" id="schedule-guided-summary">Daily at 07:00.</div>
          <label class="schedule-label" for="schedule-input">Advanced cron expression</label>
          <div class="schedule-input-wrap">
            <input class="schedule-input" type="text" id="schedule-input" placeholder="0 7,13,20 * * *" oninput="onScheduleChange(this, { skipGuidedSync: false })">
            <div style="display:flex;flex-wrap:wrap;gap:8px">
              <span id="schedule-badge" class="pill warning" style="display:none">Restart required after save</span>
            </div>
          </div>
          <div class="support-text" id="schedule-human-copy">Runs daily at 7am, 1pm, and 8pm.</div>
        </div>
        <div class="info-list">
          <div class="info-row">
            <div class="info-row-label">Last run</div>
            <div class="info-row-value" id="schedule-last-run">No completed runs yet</div>
          </div>
          <div class="info-row">
            <div class="info-row-label">Last failure</div>
            <div class="info-row-value" id="schedule-last-failure">None recorded</div>
          </div>
          <div class="info-row">
            <div class="info-row-label">Status updated</div>
            <div class="info-row-value" id="status-updated-at">Waiting for status</div>
          </div>
        </div>
      </section>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="closeSettingsModal()">Done</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let state = {
  config: null,
  originalConfig: null,
  configRevision: null,
  status: null,
  editingIndex: null,
  statusTimer: null,
};

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(function () { return null; });
  if (!res.ok) {
    throw new Error((data && data.error) || ('Request failed for ' + url));
  }
  return data;
}

async function loadConfigState() {
  const data = await fetchJson('/config');
  const revision = typeof data.revision === "number" ? data.revision : 0;
  const { revision: _r, ...config } = data;
  void _r;
  if (!Array.isArray(config.routes)) config.routes = [];
  state.config = config;
  state.originalConfig = JSON.parse(JSON.stringify(config));
  state.configRevision = revision;
}

async function loadStatusState(silent) {
  try {
    state.status = await fetchJson('/status');
  } catch (e) {
    if (!silent) {
      showToast('Failed to load status: ' + e.message, true);
    }
  }
}

async function init() {
  try {
    await Promise.all([loadConfigState(), loadStatusState(false)]);
    render();
    state.statusTimer = setInterval(function () {
      refreshStatus(false);
    }, 30000);
  } catch (e) {
    showToast('Failed to load admin UI: ' + e.message, true);
  }
}

async function refreshStatus(showToastOnSuccess) {
  await loadStatusState(!showToastOnSuccess);
  render();
  if (showToastOnSuccess) {
    showToast('Status refreshed');
  }
}

function render() {
  if (!state.config) return;
  renderHeaderHealth();
  renderSchedulePanel();
  renderRecentActivity();
  renderRoutes(state.config.routes || []);
}

function renderHeaderHealth() {
  const container = document.getElementById('header-health-indicator');
  const label = document.getElementById('header-health-label');
  if (!container || !label) return;

  const status = state.status || {};
  const schedule = status.schedule || {};
  const runtime = status.runtime || {};
  const hasFailure = !!schedule.lastFailureAt;
  const inProgress = !!runtime.inProgress;
  const updatedAt = status.generatedAt || null;

  let tone = 'success';
  let healthText = 'Healthy';
  if (inProgress) {
    tone = 'info';
    healthText = 'Run in progress';
  } else if (hasFailure) {
    tone = 'warning';
    healthText = 'Needs attention';
  }

  const freshnessText = updatedAt ? ('Checked ' + formatRelativeTime(updatedAt)) : 'Check pending';
  container.style.color = tone === 'success'
    ? 'var(--success)'
    : tone === 'warning'
      ? 'var(--warning)'
      : 'var(--primary)';
  label.textContent = healthText + ' · ' + freshnessText;
}

function renderSchedulePanel() {
  const scheduleInput = document.getElementById('schedule-input');
  if (!scheduleInput) return;
  if (scheduleInput.value !== (state.config.schedule || '')) {
    scheduleInput.value = state.config.schedule || '';
  }
  syncGuidedScheduleControls(state.config.schedule || '');

  const schedule = (state.status && state.status.schedule) || {};
  const summaryValue = document.getElementById('settings-summary-value');
  const summarySubtitle = document.getElementById('settings-summary-subtitle');
  const humanCopy = document.getElementById('schedule-human-copy');
  const expression = state.config.schedule || '';
  const modalOpen = document.getElementById('settings-modal-overlay')?.classList.contains('open');
  const openState = modalOpen ? 'Open' : 'Settings';

  if (summaryValue) {
    summaryValue.textContent = openState;
  }

  if (summarySubtitle) {
    summarySubtitle.textContent = expression
      ? 'Cron: ' + expression + ' · last run ' + (schedule.lastRunCompletedAt ? formatRelativeTime(schedule.lastRunCompletedAt) : 'none yet')
      : 'No cron expression saved yet.';
  }

  if (humanCopy) {
    humanCopy.textContent = describeCron(expression);
  }

  const liveBadge = document.getElementById('schedule-live-badge');
  liveBadge.className = 'pill ' + (schedule.valid === false ? 'danger compact' : 'soft-info compact');
  liveBadge.textContent = schedule.expression ? (schedule.valid === false ? 'Cron invalid' : 'Cron valid') : 'Schedule pending';
  document.getElementById('schedule-last-run').textContent = schedule.lastRunCompletedAt
    ? formatTimestamp(schedule.lastRunCompletedAt)
    : (schedule.lastRunStartedAt ? 'Started ' + formatRelativeTime(schedule.lastRunStartedAt) : 'No completed runs yet');
  document.getElementById('schedule-last-failure').textContent = schedule.lastFailureAt
    ? formatRelativeTime(schedule.lastFailureAt)
    : 'None recorded';
  document.getElementById('status-updated-at').textContent = state.status && state.status.generatedAt
    ? formatTimestamp(state.status.generatedAt)
    : 'Waiting for status';
}

function renderRecentActivity() {
  const card = document.getElementById('activity-card');
  if (!card) return;

  const recent = state.status && Array.isArray(state.status.recentActivity)
    ? state.status.recentActivity
    : [];
  const alerts = recent.filter(function (item) {
    return item && (item.event === 'alert-recorded' || item.event === 'alert-triggered');
  });
  const alertItems = alerts.slice(0, 6);
  const fallbackItems = recent.filter(function (item) {
    return item && item.event !== 'alert-recorded' && item.event !== 'alert-triggered';
  }).slice(0, 2);
  const renderItems = alertItems.length > 0 ? alertItems : fallbackItems;
  const hasItems = renderItems.length > 0;
  const hasAlerts = alertItems.length > 0;
  const itemLabel = renderItems.length === 1 ? 'item' : 'items';

  card.innerHTML = [
    '<div class="activity-head">',
      '<div>',
        '<div class="activity-title">Recent activity</div>',
        '<div class="activity-subtitle">',
          hasAlerts
            ? 'Latest alert outcomes, newest first.'
            : 'Latest non-alert events while waiting for alert outcomes.',
        '</div>',
      '</div>',
      pillHtml(
        hasItems ? (hasAlerts ? 'success' : 'neutral') : 'neutral',
        hasItems ? String(renderItems.length) + ' ' + itemLabel : 'No activity'
      ),
    '</div>',
    hasItems
      ? '<ul class="activity-list">' + renderItems.map(function (item) {
          const eventLabel = describeActivityEvent(item && item.event);
          const message = item && item.message ? item.message : eventLabel + '.';
          const hasTimestamp = !!(item && item.ts);
          const when = hasTimestamp ? formatRelativeTime(item.ts) : 'Time unavailable';
          const whenFull = hasTimestamp ? formatTimestamp(item.ts) : 'Timestamp unavailable';
          const alertType = item && item.alertType ? String(item.alertType) : '';
          const isAlert = item && (item.event === 'alert-recorded' || item.event === 'alert-triggered');
          const itemClass = 'activity-item'
            + (isAlert ? ' priority-alert' : '')
            + (alertType === 'lower' ? ' alert-lower' : '')
            + (alertType === 'returned' ? ' alert-returned' : '');
          const metaPills = [];
          if (item && item.route) {
            metaPills.push('<span class="activity-pill route">' + escHtml(item.route) + '</span>');
          }
          if (item && item.alertType) {
            metaPills.push(
              '<span class="activity-pill outcome '
              + escHtml(String(item.alertType))
              + '">'
              + escHtml(describeAlertOutcome(item.alertType))
              + '</span>'
            );
          } else {
            metaPills.push('<span class="activity-pill event">' + escHtml(eventLabel) + '</span>');
          }
          if (item && item.price != null) {
            metaPills.push('<span class="activity-pill metric">' + escHtml('Price ' + String(item.price)) + '</span>');
          }
          return [
            '<li class="' + itemClass + '">',
              '<div class="activity-line">',
                '<div class="activity-message">', escHtml(message), '</div>',
                '<div class="activity-time" title="', escHtml(whenFull), '">', escHtml(when), '</div>',
              '</div>',
              '<div class="activity-pill-row">', metaPills.join(''), '</div>',
            '</li>'
          ].join('');
        }).join('') + '</ul>'
      : '<div class="activity-empty">No recent activity yet. Trigger a run or refresh status after the next scheduled check.</div>',
    (recent.length > 0 && !hasAlerts)
      ? '<div class="activity-empty">No alert outcomes yet. This strip will switch to alert-first once any alert is recorded.</div>'
      : ''
  ].join('');
}

function describeActivityEvent(eventType) {
  const labels = {
    'run-started': 'Run started',
    'run-complete': 'Run completed',
    'run-failed': 'Run failed',
    'alert-triggered': 'Alert triggered',
    'alert-recorded': 'Alert recorded',
    'no-alert': 'No alert',
    'scrape-error': 'Scrape error',
    run: 'Route event'
  };
  return labels[eventType] || 'Route event';
}

function describeAlertOutcome(alertType) {
  const labels = {
    first: 'First hit',
    lower: 'Price dropped',
    returned: 'Price returned',
  };
  return labels[alertType] || 'Alert';
}

function renderRoutes(routes) {
  const grid = document.getElementById('routes-grid');
  if (!routes.length) {
    grid.innerHTML = '<div class="card empty-card">No routes configured yet. Add a trip to start tracking prices, alerts, and scrape activity.</div>';
    return;
  }

  grid.innerHTML = routes.map(function (route, index) {
    const summary = getRouteSummary(route, index);
    const flexDays = route.flexDays != null ? route.flexDays : 0;
    const tripType = route.roundTrip ? 'Round trip' : 'One way';
    const statusLabel = getRouteStatusLabel(summary, route);
    const statusTone = getRouteStatusTone(summary, route);
    const targetText = route.maxBudget != null
      ? formatCurrency(route.maxBudget, route.currency || 'USD')
      : 'New low alerts';
    const lastSeenValue = summary && summary.lastSeenPrice != null
      ? formatCurrency(summary.lastSeenPrice, summary.currency || route.currency || 'USD')
      : 'No history';
    const lastSeenSub = summary && summary.lastSeenAt
      ? 'Seen ' + formatRelativeTime(summary.lastSeenAt)
      : 'Waiting for first scrape';
    const lastAlertValue = summary && summary.lastAlert && summary.lastAlert.price != null
      ? formatCurrency(summary.lastAlert.price, summary.currency || route.currency || 'USD')
      : 'No alert sent';
    const lastAlertSub = summary && summary.lastAlert && summary.lastAlert.ts
      ? (summary.lastAlert.alertType ? summary.lastAlert.alertType + ' alert ' : '') + formatRelativeTime(summary.lastAlert.ts)
      : 'Telegram quiet so far';
    const footerChips = [
      '<span class="pill subtle compact">' + escHtml(tripType) + '</span>',
      '<span class="pill subtle compact">' + escHtml(summary && summary.trackingMode === 'budget' ? 'Budget watch' : 'New-low watch') + '</span>',
      routeHasPendingChanges(route, index) ? '<span class="pill warning compact">Unsaved edits</span>' : ''
    ].filter(Boolean).join('');
    const variantCount = summary ? summary.variantChecksPerRun : getVariantCount(route);
    const legsToken = (route.from + '→' + route.to).replace(/\s+/g, '').toUpperCase();
    const nameToken = (route.name || '').trim().replace(/\s+/g, '').toUpperCase();
    const showTripName = !!(route.name && nameToken && nameToken !== legsToken);

    let statusAccentClass = '';
    if (route.active && summary) {
      if (summary.status === 'under-budget') statusAccentClass = ' status-under-budget';
      else if (summary.status === 'above-budget') statusAccentClass = ' status-above-budget';
    }

    let fareAccentClass = '';
    if (route.active && summary && summary.lastSeenPrice != null) {
      if (summary.status === 'under-budget') fareAccentClass = ' fare-under';
      else if (summary.status === 'above-budget') fareAccentClass = ' fare-over';
    }

    const statusPill = route.active
      ? pillHtml(statusTone === 'success' ? 'success' : (statusTone === 'warning' ? 'warning' : (statusTone === 'info' ? 'info' : 'neutral')), statusLabel)
      : '';

    return [
      '<article class="card route-card', route.active ? '' : ' inactive', statusAccentClass, '">',
        '<div class="route-head">',
          '<div class="route-identity-primary">',
            '<div class="route-airports" aria-label="Trip route">',
              '<span>', escHtml(route.from), '</span>',
              '<span class="route-arrow" aria-hidden="true">→</span>',
              '<span>', escHtml(route.to), '</span>',
            '</div>',
            showTripName ? '<div class="route-trip-subtitle">' + escHtml(route.name) + '</div>' : '',
            '<div class="route-meta-line">',
              '<span>', escHtml(tripType + ' · ' + variantCount + ' check' + (variantCount === 1 ? '' : 's') + ' per run'), '</span>',
            '</div>',
          '</div>',
          '<div class="route-status-group">',
            statusPill,
          '</div>',
        '</div>',
        '<div class="route-body">',
          '<div class="route-journey">',
            '<div class="route-date-line"><span>', escHtml(formatDateRange(route.departureDate, route.returnDate, route.roundTrip)), '</span></div>',
            '<div class="route-filter-line">',
              '<span class="tag">', escHtml(route.maxStops != null ? (route.maxStops === 0 ? 'Nonstop only' : 'Up to ' + route.maxStops + ' stop' + (route.maxStops === 1 ? '' : 's')) : 'Any stops'), '</span>',
              '<span class="tag">', escHtml(route.maxDurationHours != null ? 'Up to ' + route.maxDurationHours + 'h' : 'Any duration'), '</span>',
              '<span class="tag">', escHtml(flexDays > 0 ? '±' + flexDays + ' day window' : 'Fixed date'), '</span>',
            '</div>',
          '</div>',
          '<div class="route-actions">',
            '<div class="toggle-stack"><span>', route.active ? 'Monitoring on' : 'Monitoring off', '</span>',
              '<label class="toggle" title="', route.active ? 'Turn monitoring off' : 'Turn monitoring on', '" aria-label="', route.active ? 'Turn monitoring off for this trip' : 'Turn monitoring on for this trip', '">',
                '<input type="checkbox" ', route.active ? 'checked' : '', ' onchange="toggleRoute(', index, ')">',
                '<div class="toggle-track"></div>',
                '<div class="toggle-thumb"></div>',
              '</label>',
            '</div>',
            '<div class="icon-row">',
              '<button type="button" class="icon-btn" onclick="openModal(', index, ')" title="Edit trip" aria-label="Edit trip">',
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
              '</button>',
              '<button type="button" class="icon-btn" onclick="duplicateRoute(', index, ')" title="Duplicate trip" aria-label="Duplicate trip">',
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>',
              '</button>',
              '<button type="button" class="icon-btn delete" onclick="deleteRoute(', index, ')" title="Delete trip" aria-label="Delete trip">',
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>',
              '</button>',
            '</div>',
          '</div>',
        '</div>',
        '<div class="route-metrics">',
          '<div class="route-fare-spotlight">',
            '<div class="route-fare-label">Latest seen</div>',
            '<div class="route-fare-value', fareAccentClass, '">', escHtml(lastSeenValue), '</div>',
            '<div class="route-fare-sub">', escHtml(lastSeenSub), '</div>',
          '</div>',
          '<div class="route-metrics-secondary">',
            '<div class="metric-card">',
              '<div class="metric-label">Target</div>',
              '<div class="metric-value">', escHtml(targetText), '</div>',
            '</div>',
            '<div class="metric-card">',
              '<div class="metric-label">Alert history</div>',
              '<div class="metric-value">', escHtml(lastAlertValue), '</div>',
              '<div class="metric-sub">', escHtml(lastAlertSub), '</div>',
            '</div>',
          '</div>',
        '</div>',
        '<div class="route-footer">',
          '<div class="route-footer-copy">', escHtml(summary && summary.trackingMode === 'budget' ? 'Alerts fire at or below budget, then on drops/returns under budget.' : 'Alerts fire when a new lowest seen fare is found.'), '</div>',
          '<div class="route-badge-strip">', footerChips, '</div>',
        '</div>',
      '</article>'
    ].join('');
  }).join('');
}

function getRouteSummaries() {
  return state.status && Array.isArray(state.status.routeSummaries) ? state.status.routeSummaries : [];
}

function getRouteSummary(route, index) {
  const summaries = getRouteSummaries();
  for (let i = 0; i < summaries.length; i++) {
    if (summaries[i].name === route.name) return summaries[i];
  }

  const fallback = summaries[index];
  if (fallback && fallback.from === route.from && fallback.to === route.to) {
    return fallback;
  }

  return null;
}

function getLatestAlert() {
  const summaries = getRouteSummaries()
    .filter(function (summary) { return summary.lastAlert && summary.lastAlert.ts; })
    .map(function (summary) {
      return {
        name: summary.name,
        ts: summary.lastAlert.ts,
        price: summary.lastAlert.price,
        currency: summary.currency,
        alertType: summary.lastAlert.alertType,
      };
    })
    .sort(function (a, b) {
      return new Date(b.ts).getTime() - new Date(a.ts).getTime();
    });

  return summaries[0] || null;
}

function getRuntimeLabel() {
  const status = state.status || {};
  if (status.runtime && status.runtime.inProgress) return 'Run in progress';
  if (status.schedule && status.schedule.lastFailureAt) return 'Watching for next recovery';
  return 'Standing by';
}

function getRuntimeSummaryLabel() {
  const status = state.status || {};
  if (status.runtime && status.runtime.inProgress) return 'Running';
  if (status.schedule && status.schedule.lastFailureAt) return 'Needs review';
  return 'Idle';
}

function getRuntimeTone() {
  const status = state.status || {};
  if (status.runtime && status.runtime.inProgress) return 'info';
  if (status.schedule && status.schedule.lastFailureAt) return 'warning';
  return 'success';
}

function getRouteStatusTone(summary, route) {
  if (!route.active) return 'neutral';
  if (!summary) return 'info';
  if (summary.status === 'under-budget' || summary.status === 'tracking') return 'success';
  if (summary.status === 'above-budget' || summary.status === 'watching') return 'warning';
  return 'neutral';
}

function getRouteStatusLabel(summary, route) {
  if (!route.active) return 'Inactive';
  if (!summary) return 'Awaiting status';

  const labels = {
    watching: 'Watching first result',
    'under-budget': 'Under budget',
    'above-budget': 'Above budget',
    tracking: 'Tracking new lows',
    inactive: 'Inactive',
    unknown: 'Unknown',
  };

  return labels[summary.status] || summary.status || 'Unknown';
}

function getVariantCount(route) {
  const flex = route.flexDays != null ? route.flexDays : 0;
  return flex === 0 ? 1 : flex * 2 + 1;
}

function getActiveVariantChecksFromConfig() {
  return (state.config.routes || []).reduce(function (sum, route) {
    return sum + (route.active ? getVariantCount(route) : 0);
  }, 0);
}

function routeHasPendingChanges(route, index) {
  const originalRoutes = state.originalConfig && Array.isArray(state.originalConfig.routes) ? state.originalConfig.routes : [];
  let original = null;

  for (let i = 0; i < originalRoutes.length; i++) {
    if (originalRoutes[i] && originalRoutes[i].name === route.name) {
      original = originalRoutes[i];
      break;
    }
  }

  if (!original) {
    original = originalRoutes[index];
  }

  return JSON.stringify(normalizeRoute(route)) !== JSON.stringify(normalizeRoute(original));
}

function normalizeRoute(route) {
  if (!route) return null;
  return {
    name: route.name || '',
    from: route.from || '',
    to: route.to || '',
    roundTrip: route.roundTrip !== false,
    departureDate: route.departureDate || '',
    returnDate: route.returnDate || '',
    currency: route.currency || '',
    maxBudget: route.maxBudget == null ? null : Number(route.maxBudget),
    maxStops: route.maxStops == null ? null : Number(route.maxStops),
    maxDurationHours: route.maxDurationHours == null ? null : Number(route.maxDurationHours),
    flexDays: route.flexDays == null ? 0 : Number(route.flexDays),
    active: route.active !== false,
  };
}

function formatDateRange(departureDate, returnDate, roundTrip) {
  const depart = formatShortDate(departureDate);
  if (roundTrip && returnDate) {
    return depart + ' → ' + formatShortDate(returnDate);
  }
  return depart;
}

function formatShortDate(dateStr) {
  if (!dateStr) return 'Date pending';
  const date = new Date(dateStr + 'T12:00:00Z');
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTimestamp(value) {
  if (!value) return 'No data yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatRelativeTime(value) {
  if (!value) return 'No data yet';
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return value;
  const diffMs = Date.now() - ts;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const amount = abs < minute ? Math.round(abs / 1000) + 's'
    : abs < hour ? Math.round(abs / minute) + 'm'
    : abs < day ? Math.round(abs / hour) + 'h'
    : Math.round(abs / day) + 'd';
  return future ? 'in ' + amount : amount + ' ago';
}

function formatCurrency(amount, currency) {
  if (amount == null || amount === '') return 'No target';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return (currency || 'USD') + ' ' + Number(amount).toLocaleString('en-US');
  }
}

function describeCron(expression) {
  const value = String(expression || '').trim();
  if (!value) return 'No cron expression saved yet.';

  const parts = value.split(/\s+/);
  if (parts.length < 5) return 'Cron is saved, but the expression is too short to summarize cleanly.';

  const minute = parts[0];
  const hour = parts[1];
  const dayOfMonth = parts[2];
  const month = parts[3];
  const dayOfWeek = parts[4];

  if (minute === '0' && hour === '7,13,20' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Runs daily at 7am, 1pm, and 8pm.';
  }

  if (minute === '0' && hour === '*/6' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Runs every 6 hours.';
  }

  if (minute === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Runs at the top of hour ' + hour + '.';
  }

  return 'Cron: ' + value;
}

function parseTimeValue(value) {
  const normalized = String(value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(normalized)) {
    return { hour: 7, minute: 0, text: '07:00' };
  }
  const pieces = normalized.split(':');
  const hour = Number(pieces[0]);
  const minute = Number(pieces[1]);
  if (
    Number.isNaN(hour) || Number.isNaN(minute) ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59
  ) {
    return { hour: 7, minute: 0, text: '07:00' };
  }
  return {
    hour: hour,
    minute: minute,
    text: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'),
  };
}

function isDigitsToken(value) {
  const text = String(value || '');
  if (!text) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function parseGuidedScheduleFromCron(expression) {
  const value = String(expression || '').trim();
  if (!value) {
    return {
      mode: 'daily',
      time: '07:00',
      intervalHours: 6,
      summary: 'Daily at 07:00.',
    };
  }

  const parts = value.split(/\s+/);
  if (parts.length < 5) {
    return {
      mode: 'custom',
      time: '07:00',
      intervalHours: 6,
      summary: 'Custom cron schedule in use.',
    };
  }

  const minute = parts[0];
  const hour = parts[1];
  const dayOfMonth = parts[2];
  const month = parts[3];
  const dayOfWeek = parts[4];
  const isDaily = dayOfMonth === '*' && month === '*' && dayOfWeek === '*';
  const isWeekdays = dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5';

  if ((isDaily || isWeekdays) && isDigitsToken(minute) && isDigitsToken(hour)) {
    const parsedMinute = Number(minute);
    const parsedHour = Number(hour);
    if (parsedMinute >= 0 && parsedMinute <= 59 && parsedHour >= 0 && parsedHour <= 23) {
      const time = String(parsedHour).padStart(2, '0') + ':' + String(parsedMinute).padStart(2, '0');
      return {
        mode: isWeekdays ? 'weekdays' : 'daily',
        time: time,
        intervalHours: 6,
        summary: (isWeekdays ? 'Weekdays at ' : 'Daily at ') + time + '.',
      };
    }
  }

  if (
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*' &&
    isDigitsToken(minute) &&
    hour.startsWith('*/') &&
    isDigitsToken(hour.slice(2))
  ) {
    const parsedMinute = Number(minute);
    const intervalHours = Number(hour.slice(2));
    if (parsedMinute >= 0 && parsedMinute <= 59 && intervalHours >= 1 && intervalHours <= 23) {
      return {
        mode: 'every-hours',
        time: '00:' + String(parsedMinute).padStart(2, '0'),
        intervalHours: intervalHours,
        summary: 'Every ' + intervalHours + ' hour' + (intervalHours === 1 ? '' : 's') + ' at minute ' + String(parsedMinute).padStart(2, '0') + '.',
      };
    }
  }

  return {
    mode: 'custom',
    time: '07:00',
    intervalHours: 6,
    summary: 'Custom cron schedule in use.',
  };
}

function syncGuidedScheduleControls(expression) {
  const parsed = parseGuidedScheduleFromCron(expression);
  const modeEl = document.getElementById('schedule-mode');
  const timeEl = document.getElementById('schedule-time');
  const intervalEl = document.getElementById('schedule-interval-hours');
  const summaryEl = document.getElementById('schedule-guided-summary');
  if (!modeEl || !timeEl || !intervalEl || !summaryEl) return;

  modeEl.value = parsed.mode;
  timeEl.value = parsed.time;
  intervalEl.value = String(parsed.intervalHours);
  const customMode = parsed.mode === 'custom';
  timeEl.disabled = customMode;
  intervalEl.disabled = parsed.mode !== 'every-hours';
  summaryEl.textContent = parsed.summary;
}

function guidedScheduleToCron() {
  const modeEl = document.getElementById('schedule-mode');
  const timeEl = document.getElementById('schedule-time');
  const intervalEl = document.getElementById('schedule-interval-hours');
  if (!modeEl || !timeEl || !intervalEl) return null;

  const mode = modeEl.value;
  if (mode === 'custom') return null;

  const parsedTime = parseTimeValue(timeEl.value);
  const minute = parsedTime.minute;
  const hour = parsedTime.hour;
  if (mode === 'daily') {
    return String(minute) + ' ' + String(hour) + ' * * *';
  }

  if (mode === 'weekdays') {
    return String(minute) + ' ' + String(hour) + ' * * 1-5';
  }

  if (mode === 'every-hours') {
    let interval = Number(intervalEl.value);
    if (Number.isNaN(interval) || interval < 1) interval = 1;
    if (interval > 23) interval = 23;
    intervalEl.value = String(interval);
    return String(minute) + ' */' + interval + ' * * *';
  }

  return null;
}

function onGuidedScheduleChange() {
  const modeEl = document.getElementById('schedule-mode');
  const intervalEl = document.getElementById('schedule-interval-hours');
  const timeEl = document.getElementById('schedule-time');
  if (!modeEl || !intervalEl || !timeEl) return;

  const customMode = modeEl.value === 'custom';
  timeEl.disabled = customMode;
  intervalEl.disabled = modeEl.value !== 'every-hours';

  const scheduleInput = document.getElementById('schedule-input');
  if (!scheduleInput) return;

  const cronValue = guidedScheduleToCron();
  if (cronValue == null) {
    document.getElementById('schedule-guided-summary').textContent = 'Custom cron schedule in use.';
    return;
  }

  scheduleInput.value = cronValue;
  document.getElementById('schedule-guided-summary').textContent = parseGuidedScheduleFromCron(cronValue).summary;
  onScheduleChange(scheduleInput, { skipGuidedSync: true });
}

function pillHtml(tone, text) {
  return '<span class="pill ' + escHtml(tone) + '">' + escHtml(text) + '</span>';
}

function escHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setDirtyState(dirty) {
  document.getElementById('save-btn').disabled = !dirty;
  document.getElementById('dirty-indicator').style.display = dirty ? '' : 'none';
}

function markDirty() {
  setDirtyState(true);
}

function clearDirty() {
  setDirtyState(false);
}

function onScheduleChange(input, options) {
  const opts = options || {};
  state.config.schedule = input.value;
  const changed = input.value !== (state.originalConfig.schedule || '');
  document.getElementById('schedule-badge').style.display = changed ? '' : 'none';
  if (!opts.skipGuidedSync) {
    syncGuidedScheduleControls(input.value);
  }
  markDirty();
}

function toggleRoute(index) {
  state.config.routes[index].active = !state.config.routes[index].active;
  render();
  markDirty();
}

function deleteRoute(index) {
  const name = state.config.routes[index].name;
  if (!confirm('Delete route "' + name + '"?')) return;
  state.config.routes.splice(index, 1);
  render();
  markDirty();
}

function duplicateRoute(index) {
  const source = state.config.routes[index];
  if (!source) return;

  const copy = JSON.parse(JSON.stringify(source));
  copy.name = getDuplicateRouteName(source.name);
  state.config.routes.splice(index + 1, 0, copy);
  render();
  markDirty();
  openModal(index + 1);
}

function getDuplicateRouteName(baseName) {
  const existingNames = new Set((state.config.routes || []).map(function (route) {
    return route && route.name ? route.name : '';
  }));
  const sanitizedBase = (baseName || 'Watched trip').trim() || 'Watched trip';
  let candidate = sanitizedBase + ' Copy';
  let suffix = 2;
  while (existingNames.has(candidate)) {
    candidate = sanitizedBase + ' Copy ' + suffix;
    suffix += 1;
  }
  return candidate;
}

function openModal(index) {
  state.editingIndex = index == null ? null : index;
  const route = index != null ? state.config.routes[index] : null;
  document.getElementById('modal-title').textContent = route ? 'Edit trip' : 'Add trip';
  document.getElementById('modal-mode-badge').textContent = route ? 'Editing trip' : 'New trip';
  document.getElementById('f-name').value = route && route.name ? route.name : '';
  document.getElementById('f-from').value = route && route.from ? route.from : '';
  document.getElementById('f-to').value = route && route.to ? route.to : '';
  document.getElementById('f-departure').value = route && route.departureDate ? route.departureDate : '';
  document.getElementById('f-return').value = route && route.returnDate ? route.returnDate : '';
  document.getElementById('f-roundtrip').checked = route ? route.roundTrip !== false : true;
  document.getElementById('f-currency').value = route && route.currency ? route.currency : 'BRL';
  document.getElementById('f-budget').value = route && route.maxBudget != null ? route.maxBudget : '';
  document.getElementById('f-maxstops').value = route && route.maxStops != null ? route.maxStops : '';
  document.getElementById('f-duration').value = route && route.maxDurationHours != null ? route.maxDurationHours : '';
  document.getElementById('f-flexdays').value = route && route.flexDays != null ? route.flexDays : 0;
  document.getElementById('f-active').checked = route ? route.active !== false : true;
  document.getElementById('warn-rename').style.display = 'none';
  document.getElementById('warn-flex').style.display = 'none';
  syncRoundTripField();
  onFlexChange();
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('f-name').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  state.editingIndex = null;
}

function closeModalOnBackdrop(event) {
  if (event.target === document.getElementById('modal-overlay')) {
    closeModal();
  }
}

function openSettingsModal() {
  renderSchedulePanel();
  document.getElementById('settings-modal-overlay').classList.add('open');
}

function closeSettingsModal() {
  document.getElementById('settings-modal-overlay').classList.remove('open');
}

function closeSettingsModalOnBackdrop(event) {
  if (event.target === document.getElementById('settings-modal-overlay')) {
    closeSettingsModal();
  }
}

function onFieldChange() {
  if (state.editingIndex != null) {
    const originalName = state.config.routes[state.editingIndex] && state.config.routes[state.editingIndex].name
      ? state.config.routes[state.editingIndex].name
      : '';
    const newName = document.getElementById('f-name').value;
    document.getElementById('warn-rename').style.display = newName !== originalName ? '' : 'none';
  }
}

function onRoundTripToggle() {
  syncRoundTripField();
  onFieldChange();
}

function syncRoundTripField() {
  const isRoundTrip = document.getElementById('f-roundtrip').checked;
  const returnInput = document.getElementById('f-return');
  returnInput.disabled = !isRoundTrip;
  if (!isRoundTrip) {
    returnInput.value = '';
  }
}

function onFlexChange() {
  onFieldChange();
  const value = parseInt(document.getElementById('f-flexdays').value, 10) || 0;
  const warn = document.getElementById('warn-flex');
  if (value > 5) {
    warn.textContent = 'High flex window: this creates ' + (value * 2 + 1) + ' scrape variants every scheduled run.';
    warn.style.display = '';
  } else {
    warn.style.display = 'none';
  }
}

function saveRoute() {
  const name = document.getElementById('f-name').value.trim();
  const from = document.getElementById('f-from').value.trim().toUpperCase();
  const to = document.getElementById('f-to').value.trim().toUpperCase();
  const departure = document.getElementById('f-departure').value;
  const isRoundTrip = document.getElementById('f-roundtrip').checked;
  const returnDate = isRoundTrip ? document.getElementById('f-return').value : '';

  if (!name || !from || !to || !departure) {
    showToast('Name, From, To, and Departure date are required.', true);
    return;
  }

  const flexValue = parseInt(document.getElementById('f-flexdays').value, 10) || 0;
  if (flexValue < 0 || flexValue > 7) {
    showToast('Flex days must stay between 0 and 7.', true);
    return;
  }

  const originalName = state.editingIndex != null && state.config.routes[state.editingIndex]
    ? state.config.routes[state.editingIndex].name
    : null;
  if (originalName && name !== originalName) {
    if (!confirm('Renaming "' + originalName + '" to "' + name + '" will reset its price history. Continue?')) {
      return;
    }
  }

  const route = {
    name: name,
    from: from,
    to: to,
    roundTrip: isRoundTrip,
    departureDate: departure,
    returnDate: returnDate || undefined,
    flexDays: flexValue,
    currency: (document.getElementById('f-currency').value.trim() || 'USD').toUpperCase(),
    maxStops: document.getElementById('f-maxstops').value !== '' ? parseInt(document.getElementById('f-maxstops').value, 10) : null,
    maxBudget: document.getElementById('f-budget').value !== '' ? parseFloat(document.getElementById('f-budget').value) : null,
    maxDurationHours: document.getElementById('f-duration').value !== '' ? parseFloat(document.getElementById('f-duration').value) : null,
    active: document.getElementById('f-active').checked,
  };

  if (state.editingIndex != null) {
    state.config.routes[state.editingIndex] = route;
  } else {
    state.config.routes.push(route);
  }

  render();
  markDirty();
  closeModal();
}

async function saveConfig() {
  document.getElementById('save-btn').disabled = true;
  try {
    const payload = Object.assign({}, state.config, {
      expectedRevision: state.configRevision,
    });
    const res = await fetch('/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      if (res.status === 409) {
        showToast((data.error || 'Config was changed elsewhere. Reloading…'), true);
        await loadConfigState();
        render();
      } else {
        showToast(data.error || 'Save failed', true);
      }
      document.getElementById('save-btn').disabled = false;
      return;
    }

    if (typeof data.revision === 'number') {
      state.configRevision = data.revision;
    }
    state.originalConfig = JSON.parse(JSON.stringify(state.config));
    const scheduleBadge = document.getElementById('schedule-badge');
    if (scheduleBadge) {
      scheduleBadge.style.display = 'none';
    }
    clearDirty();
    await loadStatusState(true);
    render();
    showToast(data.scheduled === 'restart-required'
      ? 'Saved. Restart the bot for the new schedule to take effect.'
      : 'Saved successfully.');
  } catch (e) {
    showToast('Network error: ' + e.message, true);
    document.getElementById('save-btn').disabled = false;
  }
}

function showToast(message, isError) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function () {
    toast.className = 'toast';
  }, 3600);
}

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    closeModal();
    closeSettingsModal();
  }
});

init();
</script>
</body>
</html>`;

// --- Express server ---

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(UI_HTML);
});

app.get("/config", (req, res) => {
  try {
    const { config, revision } = readFlightbotConfig(DATA_DIR);
    const publicShape = stripInternalConfigFields(config);
    res.json({ ...maskConfig(publicShape), revision });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/status", (req, res) => {
  try {
    res.json(buildStatusReadModel());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/config", (req, res) => {
  const incoming = req.body;
  const { expectedRevision: clientRevision, ...patch } = incoming;
  const expectedRevisionOpt =
    clientRevision !== undefined &&
    clientRevision !== null &&
    Number.isFinite(Number(clientRevision))
      ? Number(clientRevision)
      : undefined;

  // Validate schedule
  if (patch.schedule !== undefined && !cron.validate(patch.schedule)) {
    return res.status(400).json({ error: `Invalid cron expression: "${incoming.schedule}"` });
  }

  // Validate routes
  if (patch.routes) {
    for (const r of patch.routes) {
      if (!r.name || !r.from || !r.to || !r.departureDate) {
        return res.status(400).json({ error: "Route missing required field (name, from, to, departureDate)" });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.departureDate)) {
        return res.status(400).json({ error: `Route "${r.name}": departureDate must be YYYY-MM-DD` });
      }
      if (r.flexDays !== undefined && r.flexDays !== null) {
        if (!Number.isInteger(r.flexDays) || r.flexDays < 0 || r.flexDays > 7) {
          return res.status(400).json({ error: `Route "${r.name}": flexDays must be integer 0–7` });
        }
      }
    }
  }

  try {
    const onDisk = loadConfig();
    const merged = deepMergePreservingSensitive(patch, onDisk);
    writeConfigAtomic(merged, { expectedRevision: expectedRevisionOpt });
    const scheduleChanged = patch.schedule !== undefined && patch.schedule !== onDisk.schedule;
    const { revision } = readFlightbotConfig(DATA_DIR);
    res.json({ ok: true, scheduled: scheduleChanged ? "restart-required" : "live", revision });
  } catch (e) {
    if (e instanceof ConfigRevisionConflict) {
      return res.status(409).json({ error: e.message, revision: e.actualRevision });
    }
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  log(`UI server running on http://localhost:${PORT}`);
});

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

runWithLock(config, "startup");
