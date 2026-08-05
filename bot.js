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
import * as ui from "./ui.js";

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
  if (!ui.isTty) {
    try {
      console.log(line);
    } catch {
      // Ignore console failures so we can still attempt file logging.
    }
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

function firstErrorLine(err) {
  const value = err instanceof Error ? err.message : String(err);
  return value.split("\n", 1)[0];
}

function scheduleLabel(schedule) {
  const match = String(schedule).match(/^0 ([\d,]+) \* \* \*$/);
  if (!match) return schedule;
  const hours = match[1]
    .split(",")
    .map((hour) => String(Number(hour)).padStart(2, "0"))
    .join(", ");
  return `every day at ${hours}`;
}

function routeLabel(route, routeWidth) {
  const missing = Math.max(0, routeWidth - ui.displayWidth(route.name));
  return `${route.name}${" ".repeat(missing)}`;
}

function routeLog(route, message) {
  const separator = String(message).startsWith(" ") ? "" : " ";
  log(`[${route.name}]${separator}${message}`);
}

let viewRouteWidth = 0;

const view = {
  boot(config) {
    log(`Bot started. Schedule: ${config.schedule}`);
    if (!ui.isTty) return;
    const activeRoutes = config.routes.filter((route) => route.active);
    viewRouteWidth = Math.max(0, ...activeRoutes.map((route) => ui.displayWidth(route.name)));
    console.log(ui.title("flightbot", `${activeRoutes.length} route${activeRoutes.length === 1 ? "" : "s"} ${ui.glyph.dot} ${scheduleLabel(config.schedule)}`));
    console.log();
  },

  runStart() {
    log("=== Bot run started ===");
    if (ui.isTty) {
      console.log(ui.c.dim(`run ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`));
      console.log(ui.rule());
    }
  },

  routeStart(route) {
    log(`[${route.name}] Checking...`);
    if (ui.isTty) console.log(`${routeLabel(route, viewRouteWidth)}  ${ui.c.dim("checking")}`);
  },

  routeProgress(route, message, logMessage = message) {
    routeLog(route, logMessage);
    if (!ui.isTty) return;
    const prefix = `${routeLabel(route, viewRouteWidth)}  `;
    console.log(prefix + ui.c.dim(ui.truncate(message, ui.width() - ui.displayWidth(prefix))));
  },

  routeOk(route, count, best) {
    log(`[${route.name}] Best price: ${best.price}`);
    if (!ui.isTty) return;
    const parts = [
      `${count} flight${count === 1 ? "" : "s"}`,
      `best ${ui.money(best.price, route.currency)}`,
    ];
    if (route.maxBudget !== null && route.maxBudget !== undefined) {
      parts.push(`budget ${ui.money(route.maxBudget, route.currency)}`);
    }
    console.log(`${routeLabel(route, viewRouteWidth)}  ${ui.status("ok", parts.join(` ${ui.glyph.dot} `))}`);
  },

  routeErr(route, logMessage, err = logMessage) {
    routeLog(route, logMessage);
    if (!ui.isTty) return;
    const suffix = ui.c.dim(" (stack in results.log)");
    console.log(`${routeLabel(route, viewRouteWidth)}  ${ui.status("err", firstErrorLine(err))}${suffix}`);
  },

  alert(route, alertType) {
    log("Telegram alert sent successfully");
    if (ui.isTty) console.log(`${routeLabel(route, viewRouteWidth)}  ${ui.status("alert", `alert sent (${alertType})`)}`);
  },

  runtimeErr(logMessage, err) {
    log(logMessage);
    if (ui.isTty) console.error(ui.status("err", firstErrorLine(err)));
  },

  runEnd(startedAt, outcomes) {
    log("=== Bot run complete ===");
    if (!ui.isTty) return;

    const alertCount = outcomes.filter((outcome) => outcome.alertType).length;
    const errorCount = outcomes.filter((outcome) => outcome.error).length;
    const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const rows = outcomes.map((outcome) => {
      let delta = "—";
      if (outcome.best !== null && outcome.prevPrice !== null) {
        const difference = outcome.best - outcome.prevPrice;
        if (difference < 0) delta = `${ui.glyph.down} ${Math.abs(difference).toLocaleString("pt-BR")}`;
        else if (difference > 0) delta = `${ui.glyph.up} ${difference.toLocaleString("pt-BR")}`;
        else delta = "— 0";
      }
      return {
        route: outcome.route.name,
        best: ui.money(outcome.best, outcome.route.currency),
        budget: ui.money(outcome.budget, outcome.route.currency),
        delta,
        status: outcome.error ? "error" : outcome.alertType ? "alerted" : "silent",
      };
    });

    console.log(ui.rule());
    console.log(`done in ${ui.dur(Date.now() - startedAt)} ${ui.glyph.dot} ${plural(alertCount, "alert")} ${ui.glyph.dot} ${plural(errorCount, "error")}`);
    if (rows.length > 0) {
      console.log();
      console.log(ui.table([
        { key: "route", header: "route" },
        { key: "best", header: "best", align: "right" },
        { key: "budget", header: "budget", align: "right" },
        { key: "delta", header: "Δ last", align: "right" },
        { key: "status", header: "status" },
      ], rows));
    }
  },
};

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
    log: (msg) => view.routeProgress(route, msg),
  });
  view.routeProgress(route, "Screenshot captured, sending to Claude...");

  const { flights, rawText, parseError } = await extractFlightsFromScreenshot(screenshot, route, apiKey);
  if (parseError) {
    view.routeProgress(route, `Claude extraction failed to parse JSON. Raw: ${rawText.slice(0, 300)}`);
  }
  view.routeProgress(route, `Claude extracted ${flights.length} flight(s)`);

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
      return false;
    } else {
      return true;
    }
  } catch (e) {
    log(`Telegram send failed: ${e.message}`);
    return false;
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
  const startedAt = Date.now();
  view.runStart();
  const prices = loadPrices();
  const outcomes = [];

  const activeRoutes = config.routes.filter((r) => {
    if (!r.active) {
      log(`[${r.name}] Skipped (inactive)`);
      return false;
    }
    return true;
  });

  for (let i = 0; i < activeRoutes.length; i++) {
    const route = activeRoutes[i];
    view.routeStart(route);

    const variants = dateVariants(route);

    // Scrape variants sequentially to avoid bot detection and resource exhaustion
    const variantResults = [];
    let routeError = null;
    for (const variant of variants) {
      const label = variant._dateLabel ? ` (${variant._dateLabel})` : "";
      view.routeProgress(route, `${label.trimStart()} Scraping...`.trimStart(), `${label} Scraping...`);
      try {
        const results = await scrapeFlights(variant, config.anthropic.apiKey);
        view.routeProgress(route, `${label.trimStart()} Found ${results.length} result(s)`.trimStart(), `${label} Found ${results.length} result(s)`);
        for (const r of results) r._variant = variant;
        variantResults.push(results);
      } catch (e) {
        routeError ??= e;
        view.routeErr(route, `${label} Scrape error: ${e.message}`, e);
        variantResults.push([]);
      }
      // Random delay between requests to avoid bot detection
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 3000));
    }

    const allResults = variantResults.flat();

    if (allResults.length === 0) {
      const noResultsError = routeError ?? new Error("No results across all date variants");
      view.routeErr(route, "No results across all date variants, skipping", noResultsError);
      outcomes.push({
        route,
        best: null,
        budget: route.maxBudget ?? null,
        alertType: null,
        prevPrice: prices[route.name]?.lastSeenPrice ?? null,
        error: noResultsError,
      });
      continue;
    }

    allResults.sort((a, b) => a.price - b.price);
    const best = allResults[0];
    view.routeOk(route, allResults.length, best);

    const state = prices[route.name] ?? null;
    const prevPrice = state?.lastSeenPrice ?? null;
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
      const sent = await sendTelegram(config.telegram.token, config.telegram.chatId, message);
      if (sent) view.alert(route, alertType);
    } else {
      log(`[${route.name}] No alert (price: ${best.price}, lastAlertPrice: ${state?.lastAlertPrice ?? "none"})`);
      prices[route.name] = {
        ...(state ?? {}),
        lastSeenPrice: best.price,
        lastSeenAt: now,
      };
      savePrices(prices);
    }

    outcomes.push({
      route,
      best: best.price,
      budget: route.maxBudget ?? null,
      alertType,
      prevPrice,
      error: routeError,
    });

    // Rate limiting between routes
    if (i < activeRoutes.length - 1) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  view.runEnd(startedAt, outcomes);
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
    view.runtimeErr(`${trigger === "startup" ? "Initial" : "Scheduled"} run failed: ${formatError(e)}`, e);
  } finally {
    runState = { inProgress: false, startedAt: 0 };
  }
}

// --- Entry point ---

let config;
try {
  config = loadConfig();
} catch (e) {
  const message = `config error: ${firstErrorLine(e)} — check .env`;
  console.error(ui.status("err", message));
  process.exit(1);
}

cron.schedule(config.schedule, () => {
  const freshConfig = loadConfig();
  runWithLock(freshConfig, "schedule");
});

view.boot(config);

process.on("unhandledRejection", (reason) => {
  view.runtimeErr(`Unhandled rejection: ${formatError(reason)}`, reason);
});

process.on("uncaughtException", (error) => {
  view.runtimeErr(`Uncaught exception: ${formatError(error)}`, error);
});

// Run once on startup so a deploy is verifiable without waiting for the next cron tick.
runWithLock(config, "startup");
