/** Shared Google Flights scrape path. */

import Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import type { BrowserType, Page } from "playwright";
import type { FilterOptions, Flight, FlightExtractionResult, Route } from "./types.ts";

const ANTHROPIC_TIMEOUT_MS = 120_000;
const ANTHROPIC_MAX_RETRIES = 1;
const SCRAPE_TIMEOUT_MS = 180_000;
const MAX_SCROLL_STEPS = 20;
const FLIGHT_CARD_SELECTOR = "li[jsname='pbdLld'], li.pIav2d";

type Log = (message: string) => void;
type AnthropicClient = {
  messages: {
    create: (request: {
      model: string;
      max_tokens: number;
      messages: Array<{
        role: "user";
        content: Array<
          | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
          | { type: "text"; text: string }
        >;
      }>;
    }) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
};

export function buildUrl(route: Route): string {
  const depStr = route.departureDate;
  if (!depStr) throw new Error(`Route "${route.name}" is missing "departureDate"`);

  let query: string;
  if (route.roundTrip) {
    const retStr = route.returnDate;
    if (!retStr) throw new Error(`Route "${route.name}" is missing "returnDate" for a round trip`);
    query = `Round-trip ${route.from} to ${route.to} ${depStr} return ${retStr}`;
  } else {
    query = `One-way ${route.from} to ${route.to} ${depStr}`;
  }
  if (route.maxStops === 0) query += " nonstop";

  const currency = route.currency ?? "USD";
  return `https://www.google.com/travel/flights/search?q=${encodeURIComponent(query)}&curr=${currency}&hl=en`;
}

export function parseDurationHours(durationStr: string | null | undefined): number | null {
  if (!durationStr) return null;
  const hrMatch = durationStr.match(/(\d+)\s*hr/);
  const minMatch = durationStr.match(/(\d+)\s*min/);
  const hours = hrMatch ? parseInt(hrMatch[1], 10) : 0;
  const minutes = minMatch ? parseInt(minMatch[1], 10) : 0;
  return hours + minutes / 60;
}

async function dismissPopups(page: Page): Promise<void> {
  for (const selector of [
    'button[aria-label="Accept all"]',
    'button[aria-label="Reject all"]',
    '[jsname="b3VHJd"]',
    ".tHlp8d button",
  ]) {
    try {
      const element = await page.$(selector);
      if (element) await element.click();
    } catch {
      // ignore
    }
  }
}

async function sortByCheapest(page: Page, log: Log): Promise<boolean> {
  try {
    await page
      .getByRole("tab", { name: /cheapest/i })
      .first()
      .click({ timeout: 10_000 });
    await page.waitForSelector(FLIGHT_CARD_SELECTOR, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    log("Sorted by cheapest");
    return true;
  } catch {
    log("Could not switch to the Cheapest tab — continuing with default sort");
    return false;
  }
}

async function expandMoreFlights(page: Page, log: Log): Promise<boolean> {
  try {
    await page
      .getByRole("button", { name: /view more flights/i })
      .first()
      .click({ timeout: 8000 });
    await page.waitForTimeout(2500);
    log("Expanded additional flights");
    return true;
  } catch {
    log("No 'View more flights' button found — capturing what is rendered");
    return false;
  }
}

async function neutralizeStickyElements(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("*")) {
      const position = getComputedStyle(element).position;
      if (position === "fixed" || position === "sticky") {
        (element as HTMLElement).style.setProperty("position", "static", "important");
      }
    }
  });
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async (maxSteps) => {
    const step = 600;
    for (let index = 0; index < maxSteps; index += 1) {
      const before = window.scrollY;
      window.scrollBy(0, step);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const after = window.scrollY;
      const maxScroll =
        Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) -
        window.innerHeight;
      if (after === before || after >= maxScroll) break;
    }
  }, MAX_SCROLL_STEPS);
  await page.waitForTimeout(2000);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function captureFlightsScreenshot(
  route: Route,
  {
    log = console.log,
    timeoutMs = SCRAPE_TIMEOUT_MS,
    browserType = chromium,
  }: { log?: Log; timeoutMs?: number; browserType?: BrowserType } = {},
): Promise<Buffer> {
  const url = buildUrl(route);
  log(`Fetching: ${url}`);
  const browser = await browserType.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  try {
    return await withTimeout(
      (async () => {
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
        return page.screenshot({ fullPage: true });
      })(),
      timeoutMs,
      "scrape",
    );
  } finally {
    await browser.close();
  }
}

export async function extractFlightsFromScreenshot(
  screenshot: Buffer,
  route: Route,
  apiKey: string,
  { anthropicClient }: { anthropicClient?: AnthropicClient } = {},
): Promise<FlightExtractionResult> {
  const anthropic: AnthropicClient =
    anthropicClient ??
    new Anthropic({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: ANTHROPIC_MAX_RETRIES });
  const currency = route.currency ?? "BRL";
  const prompt =
    "You are extracting flight data from a Google Flights screenshot.\n" +
    "Return ONLY a valid JSON array of flight objects visible on screen. No explanation, no markdown.\n\n" +
    "Each object must have exactly these fields:\n" +
    `- price: number (${currency}, integer, digits only — e.g. 5763)\n` +
    '- airline: string\n- duration: string (e.g. "14 hr 30 min")\n- stops: number (0 for nonstop, 1 for one stop, etc.)\n' +
    '- depTime: string (e.g. "9:00 PM")\n- arrTime: string (e.g. "11:45 AM")\n\n' +
    "If a field is not visible, use null. Skip any row that has no price.";
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: screenshot.toString("base64"),
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const content = response.content.find((block) => block.type === "text");
  if (!content?.text) throw new Error("Claude extraction response did not contain a text block");
  const rawText = content.text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed: unknown = JSON.parse(rawText);
    return {
      flights: Array.isArray(parsed) ? (parsed as Flight[]) : [],
      rawText,
      parseError: null,
    };
  } catch (error) {
    return {
      flights: [],
      rawText,
      parseError: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function filterFlights(
  flights: Flight[],
  { maxStops = null, maxDurationHours = null, maxBudget = null }: FilterOptions = {},
): Flight[] {
  return flights.filter((flight) => {
    if (!flight.price || Number.isNaN(flight.price) || flight.price < 100) return false;
    if (maxBudget !== null && flight.price > maxBudget) return false;
    if (maxStops !== null && flight.stops !== null && flight.stops > maxStops) return false;
    if (maxDurationHours !== null) {
      const hours = parseDurationHours(flight.duration);
      if (hours === null || hours > maxDurationHours) return false;
    }
    return true;
  });
}
