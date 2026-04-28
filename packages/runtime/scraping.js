import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";

export async function dismissPopups(page) {
  const selectors = [
    'button[aria-label="Accept all"]',
    'button[aria-label="Reject all"]',
    '[jsname="b3VHJd"]',
    ".tHlp8d button",
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

export function createScrapingWorker({
  log,
  withTimeout,
  buildUrl,
  parseDurationHours,
  anthropicTimeoutMs = 120_000,
  anthropicMaxRetries = 1,
  scrapeTimeoutMs = 180_000,
  maxScrollSteps = 20,
}) {
  async function extractFlightsFromScreenshot(screenshot, route, apiKey) {
    const anthropic = new Anthropic({
      apiKey,
      timeout: anthropicTimeoutMs,
      maxRetries: anthropicMaxRetries,
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
        await page.evaluate(async (steps) => {
          const step = 600;
          for (let i = 0; i < steps; i++) {
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
        }, maxScrollSteps);
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
      })(), scrapeTimeoutMs, `[${route.name}] scrape`);
    } finally {
      await browser.close();
    }
  }

  return {
    dismissPopups,
    extractFlightsFromScreenshot,
    scrapeFlights,
  };
}
