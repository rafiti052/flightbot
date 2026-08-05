/**
 * Smoke test: scrapes one active route using Claude vision and optionally sends
 * a Telegram message. It shares the production scrape path in scraper.js.
 *
 * Local:      node scripts/test-scrape.js ["Route Name"] [--no-send] [-v]
 * Structured: node scripts/test-scrape.js ["Route Name"] --json [--no-send]
 * Container:  docker exec flightbot node scripts/test-scrape.js --json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildUrl,
  captureFlightsScreenshot,
  extractFlightsFromScreenshot,
  filterFlights,
} from "../scraper.js";
import * as ui from "../ui.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOT_PATH = path.join(ROOT, "test-screenshot.png");

function parseArgs(argv) {
  const options = { json: false, noSend: false, verbose: false, routeName: null };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "--no-send") options.noSend = true;
    else if (arg === "-v" || arg === "--verbose") options.verbose = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (options.routeName === null) options.routeName = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}

function dateLabel(dateStr) {
  if (!dateStr) return "N/A";
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatDateLabel(dateStr) {
  return dateLabel(dateStr);
}

function stopLabel(stops) {
  if (stops === 0) return "nonstop";
  if (stops === null || stops === undefined) return "unknown";
  return `${stops} stop${stops === 1 ? "" : "s"}`;
}

function filterLabel(filters, currency) {
  const parts = [];
  if (filters.maxStops !== null) parts.push(filters.maxStops === 0 ? "nonstop" : `≤${filters.maxStops} stops`);
  if (filters.maxDurationHours !== null) parts.push(`≤${filters.maxDurationHours}h`);
  if (filters.maxBudget !== null) parts.push(`≤ ${ui.money(filters.maxBudget, currency)}`);
  return parts.length > 0 ? parts.join(", ") : "no limits";
}

function flightRows(flights, currency) {
  return flights.map((flight, index) => ({
    number: String(index + 1),
    price: ui.money(flight.price, currency),
    airline: flight.airline ?? "—",
    stops: stopLabel(flight.stops),
    duration: flight.duration ?? "—",
    depart: flight.depTime ?? "—",
    arrive: flight.arrTime ?? "—",
  }));
}

function renderFlights(flights, currency) {
  console.log(ui.table([
    { key: "number", header: "#", align: "right" },
    { key: "price", header: "price", align: "right" },
    { key: "airline", header: "airline" },
    { key: "stops", header: "stops" },
    { key: "duration", header: "duration", align: "right" },
    { key: "depart", header: "depart", align: "right" },
    { key: "arrive", header: "arrive", align: "right" },
  ], flightRows(flights, currency)));
}

function formatMessage(route, best) {
  const currency = route.currency ?? "USD";
  const stops = best.stops === 0 ? "Nonstop" : `${best.stops} stop${best.stops > 1 ? "s" : ""}`;
  const time = best.depTime && best.arrTime
    ? `${best.depTime} → ${best.arrTime}  (${best.duration})`
    : best.duration ?? "N/A";
  const departure = formatDateLabel(route.departureDate);
  const returnDate = route.returnDate ? formatDateLabel(route.returnDate) : null;
  const dates = route.roundTrip && returnDate ? `${departure} → ${returnDate}` : departure;

  return (
    `🟢 [TEST] Good price found — ${route.name}\n\n` +
    `✈️  ${best.airline ?? "Unknown airline"}  ·  ${stops}\n` +
    `📅  ${dates}\n` +
    `🕐  ${time}\n` +
    `💰  ${currency} ${best.price.toLocaleString("pt-BR")}\n\n` +
    `🔗 [Search on Google Flights](${buildUrl(route)})`
  );
}

function printStage(stage) {
  const detail = stage.detail ? `  ${ui.c.dim(stage.detail)}` : "";
  const timing = stage.durationMs === null ? "" : `  ${ui.c.dim(ui.dur(stage.durationMs))}`;
  console.log(`${ui.status(stage.status, stage.label)}${detail}${timing}`);
}

async function runSmokeTest(options) {
  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {
    // Fall back to environment variables injected by the container.
  }

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf-8"));
  if (!process.env.ANTHROPIC_KEY) throw new Error("ANTHROPIC_KEY is not set (check .env)");
  if (!options.noSend && !process.env.TELEGRAM_KEY) throw new Error("TELEGRAM_KEY is not set (check .env)");
  if (!options.noSend && !process.env.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_CHAT_ID is not set (check .env)");

  const route = options.routeName
    ? config.routes.find((candidate) => candidate.active && candidate.name === options.routeName)
    : config.routes.find((candidate) => candidate.active);
  if (!route) {
    throw new Error(options.routeName
      ? `No active route named "${options.routeName}" found.`
      : "No active route found in config.json");
  }

  const startedAt = Date.now();
  const result = {
    ok: false,
    route: {
      name: route.name,
      from: route.from,
      to: route.to,
      departureDate: route.departureDate,
      returnDate: route.returnDate ?? null,
      url: buildUrl(route),
    },
    stages: [],
    flights: [],
    filters: {
      maxBudget: route.maxBudget ?? null,
      maxStops: route.maxStops ?? null,
      maxDurationHours: route.maxDurationHours ?? null,
      passed: 0,
      extracted: 0,
    },
    telegram: { status: options.noSend ? "skipped" : "pending", chatId: null },
    screenshot: { path: SCREENSHOT_PATH, bytes: 0, saved: false },
    rawText: "",
    error: null,
    durationMs: 0,
  };

  if (!options.json) {
    console.log();
    console.log(ui.title("flightbot smoke test"));
    console.log(ui.kv("route", `${route.name}        dates  ${dateLabel(route.departureDate)} → ${dateLabel(route.returnDate)}`));
    console.log();
  }

  const scrapeMessages = [];
  const scrapeStartedAt = Date.now();
  const progress = options.json ? null : ui.spinner("loading Google Flights");
  let screenshot;
  try {
    screenshot = await captureFlightsScreenshot(route, { log: (message) => scrapeMessages.push(message) });
    result.stages.push({ name: "page", label: "page loaded", status: "ok", durationMs: Date.now() - scrapeStartedAt });
    progress?.succeed("page loaded");
  } catch (error) {
    result.stages.push({ name: "page", label: "page load", status: "err", durationMs: Date.now() - scrapeStartedAt, detail: error.message });
    progress?.fail(`page load  ${error.message}`);
    throw Object.assign(error, { result });
  }

  const cardTimeout = scrapeMessages.find((message) => message.startsWith("Timed out waiting for flight cards"));
  if (cardTimeout) {
    const timeoutStage = {
      name: "flight_cards",
      label: "flight cards timed out",
      status: "warn",
      durationMs: null,
      detail: cardTimeout,
    };
    result.stages.push(timeoutStage);
    if (!options.json) printStage(timeoutStage);
  }

  const sorted = scrapeMessages.includes("Sorted by cheapest");
  const sortStage = {
    name: "sort",
    label: sorted ? "sorted by cheapest" : "default sorting used",
    status: sorted ? "ok" : "warn",
    durationMs: null,
  };
  result.stages.push(sortStage);

  const expanded = scrapeMessages.includes("Expanded additional flights");
  const expandStage = {
    name: "expand",
    label: expanded ? "expanded more flights" : "no more-flights control",
    status: expanded ? "ok" : "warn",
    durationMs: null,
  };
  result.stages.push(expandStage);
  if (!options.json) {
    printStage(sortStage);
    printStage(expandStage);
  }

  result.screenshot.bytes = screenshot.length;
  const screenshotStartedAt = Date.now();
  let screenshotStage;
  try {
    fs.writeFileSync(SCREENSHOT_PATH, screenshot);
    result.screenshot.saved = true;
    screenshotStage = {
      name: "screenshot",
      label: "screenshot",
      status: "ok",
      durationMs: Date.now() - screenshotStartedAt,
      detail: `${Math.round(screenshot.length / 1024).toLocaleString("en-US")} KB → test-screenshot.png`,
    };
  } catch (error) {
    screenshotStage = {
      name: "screenshot",
      label: "screenshot not saved",
      status: "warn",
      durationMs: Date.now() - screenshotStartedAt,
      detail: error.message,
    };
  }
  result.stages.push(screenshotStage);
  if (!options.json) printStage(screenshotStage);

  const extractionStartedAt = Date.now();
  const extraction = await extractFlightsFromScreenshot(screenshot, route, process.env.ANTHROPIC_KEY);
  result.rawText = extraction.rawText;
  result.filters.extracted = extraction.flights.length;
  const extractionStage = {
    name: "extraction",
    label: "claude extraction",
    status: extraction.parseError ? "err" : "ok",
    durationMs: Date.now() - extractionStartedAt,
    detail: `${extraction.flights.length} flight${extraction.flights.length === 1 ? "" : "s"}`,
  };
  result.stages.push(extractionStage);
  if (!options.json) printStage(extractionStage);

  if ((options.verbose || extraction.parseError) && !options.json) {
    console.log();
    console.log(ui.c.dim("Claude raw response"));
    for (const line of extraction.rawText.split("\n")) console.log(`${ui.c.dim("│")} ${line}`);
  }
  if (extraction.parseError) {
    throw Object.assign(new Error("Failed to parse Claude response as JSON."), { result });
  }

  const filters = {
    maxBudget: route.maxBudget ?? null,
    maxStops: route.maxStops ?? null,
    maxDurationHours: route.maxDurationHours ?? null,
  };
  const filterStartedAt = Date.now();
  const filtered = filterFlights(extraction.flights, filters).sort((a, b) => a.price - b.price);
  result.flights = filtered;
  result.filters.passed = filtered.length;
  const filterStage = {
    name: "filters",
    label: "filters",
    status: filtered.length > 0 ? "ok" : "err",
    durationMs: Date.now() - filterStartedAt,
    detail: `${filtered.length} pass  (${filterLabel(filters, route.currency ?? "USD")})`,
  };
  result.stages.push(filterStage);
  if (!options.json) printStage(filterStage);

  if (filtered.length === 0) {
    const cheapest = [...extraction.flights]
      .filter((flight) => Number.isFinite(flight.price))
      .sort((a, b) => a.price - b.price)[0] ?? null;
    result.cheapestSeen = cheapest;
    if (!options.json && cheapest) {
      console.log();
      renderFlights([cheapest], route.currency ?? "USD");
    }
    const detail = cheapest
      ? `Cheapest seen: ${ui.money(cheapest.price, route.currency)} (${cheapest.airline}, ${stopLabel(cheapest.stops)}, ${cheapest.duration})`
      : "Nothing was extracted from the page.";
    throw Object.assign(new Error(`No flights passed filters. ${detail}`), { result });
  }

  if (!options.json) {
    console.log();
    renderFlights(filtered, route.currency ?? "USD");
  }

  const best = filtered[0];
  const message = formatMessage(route, best);
  result.telegram.preview = message;

  if (!options.json) {
    console.log();
    console.log(ui.c.dim("telegram preview"));
    for (const line of message.split("\n")) console.log(`${ui.c.dim("│")} ${line}`);
  }

  if (options.noSend) {
    const telegramStage = { name: "telegram", label: "telegram send skipped", status: "warn", durationMs: null };
    result.stages.push(telegramStage);
    if (!options.json) printStage(telegramStage);
  } else {
    const telegramStartedAt = Date.now();
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_KEY}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      }),
    });
    result.telegram.chatId = process.env.TELEGRAM_CHAT_ID;
    result.telegram.status = response.ok ? "sent" : "failed";
    const telegramStage = {
      name: "telegram",
      label: response.ok ? `sent to chat ${process.env.TELEGRAM_CHAT_ID}` : `telegram error ${response.status}`,
      status: response.ok ? "ok" : "err",
      durationMs: Date.now() - telegramStartedAt,
    };
    result.stages.push(telegramStage);
    if (!options.json) printStage(telegramStage);
    if (!response.ok) {
      const body = await response.text();
      throw Object.assign(new Error(`Telegram error ${response.status}: ${body}`), { result });
    }
  }

  result.ok = true;
  result.durationMs = Date.now() - startedAt;
  return result;
}

let options;
const wantsJson = process.argv.slice(2).includes("--json");
try {
  options = parseArgs(process.argv.slice(2));
  const result = await runSmokeTest(options);
  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    const checks = result.stages.filter((stage) => stage.status === "ok").length;
    const warnings = result.stages.filter((stage) => stage.status === "warn").length;
    console.log();
    console.log(`${ui.c.ok("PASS")}  ${checks} checks ${ui.glyph.dot} ${warnings} warning${warnings === 1 ? "" : "s"} ${ui.glyph.dot} ${ui.dur(result.durationMs)}`);
  }
} catch (error) {
  const result = error.result ?? {
    ok: false,
    route: null,
    stages: [],
    flights: [],
    filters: null,
    telegram: null,
    screenshot: null,
    rawText: "",
    durationMs: 0,
  };
  result.ok = false;
  result.error = error.message;
  if (result.durationMs === 0 && result.stages.length > 0) {
    result.durationMs = result.stages.reduce((sum, stage) => sum + (stage.durationMs ?? 0), 0);
  }

  if (options?.json || wantsJson) console.log(JSON.stringify(result));
  else {
    console.error();
    console.error(`${ui.c.err("FAIL")}  ${error.message}`);
  }
  process.exitCode = 1;
}
