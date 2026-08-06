import { describe, expect, it, vi } from "vitest";
import type { BrowserType } from "playwright";
import type { Flight, Route } from "../types.ts";
import {
  buildUrl,
  captureFlightsScreenshot,
  extractFlightsFromScreenshot,
  filterFlights,
  parseDurationHours,
} from "../scraper.ts";

const route: Route = {
  name: "Sao Paulo to Lisbon",
  from: "GRU",
  to: "LIS",
  roundTrip: true,
  departureDate: "2026-10-01",
  returnDate: "2026-10-12",
  currency: "BRL",
  active: true,
};

const flight = (overrides: Partial<Flight> = {}): Flight => ({
  price: 500,
  airline: "Example Air",
  duration: "4 hr 30 min",
  stops: 0,
  depTime: "9:00 PM",
  arrTime: "11:45 AM",
  ...overrides,
});

describe("buildUrl", () => {
  it("builds round-trip, one-way, and nonstop query URLs", () => {
    expect(decodeURIComponent(buildUrl(route))).toContain(
      "Round-trip GRU to LIS 2026-10-01 return 2026-10-12",
    );
    expect(decodeURIComponent(buildUrl({ ...route, roundTrip: false }))).toContain(
      "One-way GRU to LIS 2026-10-01",
    );
    expect(decodeURIComponent(buildUrl({ ...route, maxStops: 0 }))).toContain(" nonstop&curr=BRL");
  });

  it("rejects missing departure and round-trip return dates", () => {
    expect(() => buildUrl({ ...route, departureDate: "" })).toThrow(
      'Route "Sao Paulo to Lisbon" is missing "departureDate"',
    );
    expect(() => buildUrl({ ...route, returnDate: null })).toThrow(
      'Route "Sao Paulo to Lisbon" is missing "returnDate" for a round trip',
    );
  });
});

describe("parseDurationHours", () => {
  it("parses hour-only, minute-only, combined, and missing durations", () => {
    expect(parseDurationHours("14 hr")).toBe(14);
    expect(parseDurationHours("45 min")).toBe(0.75);
    expect(parseDurationHours("14 hr 30 min")).toBe(14.5);
    expect(parseDurationHours(null)).toBeNull();
  });
});

describe("filterFlights", () => {
  it("filters invalid prices and every configured constraint", () => {
    const flights = [
      flight({ price: 99 }),
      flight({ price: 600, stops: 1 }),
      flight({ price: 700, duration: "9 hr" }),
      flight({ price: 500, duration: null }),
      flight({ price: 450, stops: 0, duration: "4 hr" }),
    ];
    expect(filterFlights(flights)).toEqual(flights.slice(1));
    expect(filterFlights(flights, { maxBudget: 550 })).toEqual([flights[3], flights[4]]);
    expect(filterFlights(flights, { maxStops: 0 })).toEqual([flights[2], flights[3], flights[4]]);
    expect(filterFlights(flights, { maxDurationHours: 5 })).toEqual([flights[1], flights[4]]);
    expect(filterFlights(flights, { maxBudget: 550, maxStops: 0, maxDurationHours: 5 })).toEqual([
      flights[4],
    ]);
  });
});

const extractionClient = (content: Array<{ type: string; text?: string }>) => ({
  messages: { create: vi.fn().mockResolvedValue({ content }) },
});

describe("extractFlightsFromScreenshot", () => {
  it("uses the fixed model and prompt, then parses a text response", async () => {
    const client = extractionClient([{ type: "text", text: '```json\n[{"price":500}]\n```' }]);
    const result = await extractFlightsFromScreenshot(Buffer.from("png"), route, "key", {
      anthropicClient: client,
    });
    expect(result).toEqual({
      flights: [{ price: 500 }],
      rawText: '[{"price":500}]',
      parseError: null,
    });
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 8192,
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Return ONLY a valid JSON array"),
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it("returns an empty result for JSON non-arrays and malformed text", async () => {
    const objectResult = await extractFlightsFromScreenshot(Buffer.alloc(0), route, "key", {
      anthropicClient: extractionClient([{ type: "text", text: "{}" }]),
    });
    const malformedResult = await extractFlightsFromScreenshot(Buffer.alloc(0), route, "key", {
      anthropicClient: extractionClient([{ type: "text", text: "not json" }]),
    });
    expect(objectResult).toEqual({ flights: [], rawText: "{}", parseError: null });
    expect(malformedResult.flights).toEqual([]);
    expect(malformedResult.rawText).toBe("not json");
    expect(malformedResult.parseError).toBeInstanceOf(Error);
  });

  it("selects a text block after non-text content and rejects a missing text block", async () => {
    const textAfterImage = await extractFlightsFromScreenshot(Buffer.alloc(0), route, "key", {
      anthropicClient: extractionClient([{ type: "tool_use" }, { type: "text", text: "[]" }]),
    });
    await expect(
      extractFlightsFromScreenshot(Buffer.alloc(0), route, "key", {
        anthropicClient: extractionClient([{ type: "tool_use" }]),
      }),
    ).rejects.toThrow("Claude extraction response did not contain a text block");
    expect(textAfterImage).toEqual({ flights: [], rawText: "[]", parseError: null });
  });
});

function fakeBrowserType({ hang = false }: { hang?: boolean } = {}): {
  browserType: BrowserType;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn().mockResolvedValue(undefined);
  const page = {
    $: vi.fn().mockResolvedValue(null),
    getByRole: vi
      .fn()
      .mockReturnValue({ first: () => ({ click: vi.fn().mockResolvedValue(undefined) }) }),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("screenshot")),
  };
  const browser = {
    newContext: hang
      ? vi.fn().mockReturnValue(new Promise(() => {}))
      : vi.fn().mockResolvedValue({ newPage: vi.fn().mockResolvedValue(page) }),
    close,
  };
  return {
    browserType: { launch: vi.fn().mockResolvedValue(browser) } as unknown as BrowserType,
    close,
  };
}

describe("captureFlightsScreenshot", () => {
  it("captures with the production selector and closes the injected browser", async () => {
    const fake = fakeBrowserType();
    await expect(
      captureFlightsScreenshot(route, { browserType: fake.browserType, log: vi.fn() }),
    ).resolves.toEqual(Buffer.from("screenshot"));
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("times out and still closes the injected browser", async () => {
    const fake = fakeBrowserType({ hang: true });
    await expect(
      captureFlightsScreenshot(route, {
        browserType: fake.browserType,
        timeoutMs: 1,
        log: vi.fn(),
      }),
    ).rejects.toThrow("scrape timed out after 1ms");
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
