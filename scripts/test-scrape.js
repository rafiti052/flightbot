/**
 * Smoke test: scrapes one active route using Claude vision and sends a Telegram message.
 * Runs the same scrape path as bot.js (see scraper.js).
 *
 * Local:      node scripts/test-scrape.js ["Route Name"]
 * Container:  docker exec flightbot node scripts/test-scrape.js
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

// Scripts live one level below the app root; config/.env/screenshots resolve there.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // No .env file present — fall back to env vars injected by the environment.
}

const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf-8"));
if (!process.env.ANTHROPIC_KEY) throw new Error("ANTHROPIC_KEY is not set (check .env)");
if (!process.env.TELEGRAM_KEY) throw new Error("TELEGRAM_KEY is not set (check .env)");
if (!process.env.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_CHAT_ID is not set (check .env)");
config.anthropic = { ...config.anthropic, apiKey: process.env.ANTHROPIC_KEY };
config.telegram = {
  ...config.telegram,
  token: process.env.TELEGRAM_KEY,
  chatId: process.env.TELEGRAM_CHAT_ID,
};

const routeArg = process.argv[2];
const route = routeArg
  ? config.routes.find((r) => r.active && r.name === routeArg)
  : config.routes.find((r) => r.active);
if (!route) {
  console.error(routeArg ? `No active route named "${routeArg}" found.` : "No active route found in config.json");
  process.exit(1);
}

console.log(`\nSmoke test — route: ${route.name}`);
console.log(`Dates: ${route.departureDate} → ${route.returnDate ?? "N/A"}\n`);

// --- Navigate and screenshot ---

const screenshot = await captureFlightsScreenshot(route);

const screenshotPath = path.join(ROOT, "test-screenshot.png");
try {
  fs.writeFileSync(screenshotPath, screenshot);
  console.log(`Screenshot saved to ${screenshotPath}`);
} catch (e) {
  // Read-only or missing mount inside the container — not fatal for the test.
  console.warn(`Could not save screenshot: ${e.message}`);
}

// --- Claude extraction ---

console.log("Sending screenshot to Claude...");

const { flights, rawText, parseError } = await extractFlightsFromScreenshot(
  screenshot,
  route,
  config.anthropic.apiKey,
);

console.log("\n--- Claude raw response ---\n", rawText, "\n---------------------------\n");

if (parseError) {
  console.error("Failed to parse Claude response as JSON.");
  process.exit(1);
}

console.log(`Claude extracted ${flights.length} flight(s)`);

// --- Apply filters ---

const maxBudget = route.maxBudget ?? null;
const maxStops = route.maxStops ?? null;
const maxDurationHours = route.maxDurationHours ?? null;

const filtered = filterFlights(flights, { maxStops, maxDurationHours, maxBudget });

console.log(`${filtered.length} flight(s) pass filters (budget: ${maxBudget}, stops: ${maxStops}, duration: ${maxDurationHours}h)`);

if (filtered.length === 0) {
  const cheapest = [...flights].sort((a, b) => a.price - b.price)[0];
  if (cheapest) {
    console.error(`No flights passed filters. Cheapest seen: ${cheapest.price} (${cheapest.airline}, ${cheapest.stops} stop(s), ${cheapest.duration})`);
  } else {
    console.error("No flights passed filters — nothing was extracted from the page.");
  }
  process.exit(1);
}

filtered.sort((a, b) => a.price - b.price);
const best = filtered[0];
console.log("\nBest flight:\n", best);

// --- Format and send ---

function formatDateLabel(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const currency = route.currency ?? "USD";
const stopsLabel = best.stops === 0 ? "Nonstop" : `${best.stops} stop${best.stops > 1 ? "s" : ""}`;
const priceFormatted = best.price.toLocaleString("pt-BR");
const timeStr = best.depTime && best.arrTime
  ? `${best.depTime} → ${best.arrTime}  (${best.duration})`
  : best.duration ?? "N/A";
const depLabel = formatDateLabel(route.departureDate);
const retLabel = route.returnDate ? formatDateLabel(route.returnDate) : null;
const dateStr = route.roundTrip && retLabel ? `${depLabel} → ${retLabel}` : depLabel;

const message =
  `🟢 [TEST] Good price found — ${route.name}\n\n` +
  `✈️  ${best.airline ?? "Unknown airline"}  ·  ${stopsLabel}\n` +
  `📅  ${dateStr}\n` +
  `🕐  ${timeStr}\n` +
  `💰  ${currency} ${priceFormatted}\n\n` +
  `🔗 [Search on Google Flights](${buildUrl(route)})`;

console.log("\n--- Telegram message preview ---\n");
console.log(message);
console.log("\n--------------------------------\n");

const res = await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: config.telegram.chatId, text: message, parse_mode: "Markdown", disable_web_page_preview: false }),
});

if (res.ok) {
  console.log("Telegram message sent successfully.");
} else {
  console.error("Telegram error:", res.status, await res.text());
  process.exit(1);
}
