/**
 * Shared Google Flights scrape path.
 *
 * Both bot.js (production) and test-run.js (smoke test) import from here so the
 * test exercises the same code the bot runs. Callers inject their own logger:
 * bot.js appends to results.log, test-run.js prints to the console.
 */

import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_TIMEOUT_MS = 120_000;
const ANTHROPIC_MAX_RETRIES = 1;
const SCRAPE_TIMEOUT_MS = 180_000;
const MAX_SCROLL_STEPS = 20;
const FLIGHT_CARD_SELECTOR = "li[jsname='pbdLld'], li.pIav2d";

// --- URL building ---

export function buildUrl(route) {
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

  // Google Flights parses "nonstop" out of the free-text query. This only narrows
  // what the page renders — filterFlights() below remains the authoritative filter.
  // There is no reliable phrasing for "at most N stops", so only hint on nonstop.
  if (route.maxStops === 0) query += " nonstop";

  const currency = route.currency ?? "USD";
  return `https://www.google.com/travel/flights/search?q=${encodeURIComponent(query)}&curr=${currency}&hl=en`;
}

// --- Duration parsing ---

export function parseDurationHours(durationStr) {
  if (!durationStr) return null;
  const hrMatch = durationStr.match(/(\d+)\s*hr/);
  const minMatch = durationStr.match(/(\d+)\s*min/);
  const hours = hrMatch ? parseInt(hrMatch[1]) : 0;
  const minutes = minMatch ? parseInt(minMatch[1]) : 0;
  return hours + minutes / 60;
}

// --- Page interaction ---

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

/**
 * Google Flights defaults to "Best" ranking, which trades price off against
 * convenience and can leave the cheapest itinerary entirely unrendered. Switch to
 * the Cheapest tab so the page actually contains what we're shopping for.
 * Matched by ARIA role/name rather than Google's churn-prone class names.
 */
async function sortByCheapest(page, log) {
  try {
    await page.getByRole("tab", { name: /cheapest/i }).first().click({ timeout: 10_000 });
    // The list re-renders in place, so re-wait for cards rather than trusting the click.
    await page.waitForSelector(FLIGHT_CARD_SELECTOR, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    log("Sorted by cheapest");
    return true;
  } catch {
    log("Could not switch to the Cheapest tab — continuing with default sort");
    return false;
  }
}

/** Results are truncated behind a "View more flights" button. Expand once. */
async function expandMoreFlights(page, log) {
  try {
    await page.getByRole("button", { name: /view more flights/i }).first().click({ timeout: 8000 });
    await page.waitForTimeout(2500);
    log("Expanded additional flights");
    return true;
  } catch {
    log("No 'View more flights' button found — capturing what is rendered");
    return false;
  }
}

/**
 * fullPage screenshots are stitched from viewport slices, and position:fixed /
 * sticky elements repaint in every slice — the Google header ends up painted over
 * a flight row mid-page. Flattening them to static (plus killing overlay tooltips)
 * keeps every row legible to Claude.
 */
async function neutralizeStickyElements(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("*")) {
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") {
        el.style.setProperty("position", "static", "important");
      }
    }
  });
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function autoScroll(page) {
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

// --- Screenshot capture ---

/**
 * Loads the route's Google Flights page, sorts by cheapest, expands the result
 * list, and returns a full-page PNG buffer.
 */
export async function captureFlightsScreenshot(route, { log = console.log, timeoutMs = SCRAPE_TIMEOUT_MS } = {}) {
  const url = buildUrl(route);
  log(`Fetching: ${url}`);

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
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await dismissPopups(page);

      try {
        await page.waitForSelector(FLIGHT_CARD_SELECTOR, { timeout: 30_000 });
      } catch {
        log("Timed out waiting for flight cards — continuing");
      }
      await page.waitForTimeout(3000);

      await sortByCheapest(page, log);
      await expandMoreFlights(page, log);
      await autoScroll(page);
      await neutralizeStickyElements(page);

      return await page.screenshot({ fullPage: true });
    })(), timeoutMs, "scrape");
  } finally {
    await browser.close();
  }
}

// --- Claude extraction ---

/**
 * Sends the screenshot to Claude for structured extraction.
 * Returns { flights, rawText, parseError } so callers can distinguish a genuine
 * zero-flight page from a malformed/truncated response.
 */
export async function extractFlightsFromScreenshot(screenshot, route, apiKey) {
  const anthropic = new Anthropic({
    apiKey,
    timeout: ANTHROPIC_TIMEOUT_MS,
    maxRetries: ANTHROPIC_MAX_RETRIES,
  });
  const currency = route.currency ?? "BRL";

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
    max_tokens: 8192,
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
  try {
    const parsed = JSON.parse(rawText);
    return { flights: Array.isArray(parsed) ? parsed : [], rawText, parseError: null };
  } catch (e) {
    return { flights: [], rawText, parseError: e };
  }
}

// --- Filtering ---

/**
 * `maxBudget` is optional: bot.js deliberately omits it so evaluateAlert() can
 * reason about over-budget prices, while the smoke test applies it directly.
 */
export function filterFlights(flights, { maxStops = null, maxDurationHours = null, maxBudget = null } = {}) {
  return flights.filter((f) => {
    if (!f.price || isNaN(f.price) || f.price < 100) return false;
    if (maxBudget !== null && f.price > maxBudget) return false;
    if (maxStops !== null && f.stops !== null && f.stops > maxStops) return false;
    if (maxDurationHours !== null) {
      const h = parseDurationHours(f.duration);
      if (h === null || h > maxDurationHours) return false;
    }
    return true;
  });
}
