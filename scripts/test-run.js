/**
 * Smoke test: scrapes the first active route using Claude vision and sends a Telegram message.
 * Run with: node test-run.js
 */

import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import { buildUrl, parseDurationHours } from "../apps/bot/runtime/core.js";
import { loadConfig, resolveOutputPath, writeOutputFile } from "./helpers.js";

const { config } = loadConfig();

const routeArg = process.argv[2];
const route = routeArg
  ? config.routes.find((r) => r.active && r.name === routeArg)
  : config.routes.find((r) => r.active);
if (!route) {
  console.error(routeArg ? `No active route named "${routeArg}" found.` : "No active route found in config.");
  process.exit(1);
}

console.log(`\nSmoke test - route: ${route.name}`);
console.log(`Dates: ${route.departureDate} -> ${route.returnDate ?? "N/A"}`);

const url = buildUrl(route);
console.log(`\nURL: ${url}\n`);

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  locale: "en-US",
  timezoneId: "America/Sao_Paulo",
  viewport: { width: 1280, height: 1600 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

console.log("Loading page...");
await page.goto(url, { waitUntil: "domcontentloaded" });

for (const sel of ['button[aria-label="Accept all"]', 'button[aria-label="Reject all"]', '[jsname="b3VHJd"]', ".tHlp8d button"]) {
  try {
    const el = await page.$(sel);
    if (el) await el.click();
  } catch {}
}

try {
  await page.waitForSelector("li[jsname='pbdLld'], li.pIav2d", { timeout: 30000 });
} catch {
  console.warn("Timed out waiting for flight cards - continuing anyway");
}
await page.waitForTimeout(3000);

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
await browser.close();

const screenshotPath = resolveOutputPath("test-screenshot.png");
writeOutputFile(screenshotPath, screenshot);
console.log(`Screenshot saved to ${screenshotPath}`);

console.log("Sending screenshot to Claude...");

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
const currency = route.currency ?? "USD";

const prompt =
  `You are extracting flight data from a Google Flights screenshot.\n` +
  `Return ONLY a valid JSON array of flight objects visible on screen. No explanation, no markdown.\n\n` +
  `Each object must have exactly these fields:\n` +
  `- price: number (${currency}, integer, digits only - e.g. 5763)\n` +
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

const rawText = response.content[0].text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
console.log("\n--- Claude raw response ---\n", rawText, "\n---------------------------\n");

let flights = [];
try {
  flights = JSON.parse(rawText);
  if (!Array.isArray(flights)) flights = [];
} catch {
  console.error("Failed to parse Claude response as JSON.");
  process.exit(1);
}

console.log(`Claude extracted ${flights.length} flight(s)`);

const maxBudget = route.maxBudget ?? null;
const maxStops = route.maxStops ?? null;
const maxDurationHours = route.maxDurationHours ?? null;

const filtered = flights.filter((f) => {
  if (!f.price || isNaN(f.price) || f.price < 100) return false;
  if (maxBudget !== null && f.price > maxBudget) return false;
  if (maxStops !== null && f.stops !== null && f.stops > maxStops) return false;
  if (maxDurationHours !== null) {
    const h = parseDurationHours(f.duration);
    if (h === null || h > maxDurationHours) return false;
  }
  return true;
});

console.log(`${filtered.length} flight(s) pass filters (budget: ${maxBudget}, stops: ${maxStops}, duration: ${maxDurationHours}h)`);

if (filtered.length === 0) {
  console.error("No flights passed filters.");
  process.exit(1);
}

filtered.sort((a, b) => a.price - b.price);
const best = filtered[0];
console.log("\nBest flight:\n", best);

function formatDateLabel(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const stopsLabel = best.stops === 0 ? "Nonstop" : `${best.stops} stop${best.stops > 1 ? "s" : ""}`;
const priceFormatted = best.price.toLocaleString("pt-BR");
const timeStr = best.depTime && best.arrTime
  ? `${best.depTime} -> ${best.arrTime}  (${best.duration})`
  : best.duration ?? "N/A";
const depLabel = formatDateLabel(route.departureDate);
const retLabel = route.returnDate ? formatDateLabel(route.returnDate) : null;
const dateStr = route.roundTrip && retLabel ? `${depLabel} -> ${retLabel}` : depLabel;

const message =
  `🟢 [TEST] Good price found - ${route.name}\n\n` +
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
}
