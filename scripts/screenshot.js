/**
 * Navigates to Google Flights for the first active route and saves a screenshot.
 * Run with: node scripts/screenshot.js
 */

import { chromium } from "playwright";
import path from "path";
import { buildUrl } from "../apps/bot/runtime/core.js";
import { loadConfig, resolveOutputPath } from "./helpers.js";

const { config } = loadConfig();
const route = config.routes.find((r) => r.active);
if (!route) {
  console.error("No active route found.");
  process.exit(1);
}

const url = buildUrl(route);
console.log(`Route: ${route.name}`);
console.log(`URL: ${url}`);

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  locale: "en-US",
  timezoneId: "America/Sao_Paulo",
  viewport: { width: 1280, height: 1600 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

console.log("Loading...");
await page.goto(url, { waitUntil: "domcontentloaded" });

for (const sel of ['button[aria-label="Accept all"]', 'button[aria-label="Reject all"]', '[jsname="b3VHJd"]', ".tHlp8d button"]) {
  try {
    const el = await page.$(sel);
    if (el) {
      await el.click();
      console.log(`Dismissed: ${sel}`);
    }
  } catch {}
}

try {
  await page.waitForSelector("li[jsname='pbdLld'], li.pIav2d", { timeout: 30000 });
  console.log("Flight cards detected.");
} catch {
  console.warn("Timed out waiting for cards - saving screenshot anyway.");
}
await page.waitForTimeout(3000);

const screenshotPath = resolveOutputPath(".tmp/flightbot/screenshot.png");
await page.screenshot({ path: screenshotPath, fullPage: true });
await browser.close();

console.log(`\nScreenshot saved: ${path.relative(process.cwd(), screenshotPath) || screenshotPath}`);
