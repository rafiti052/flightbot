import { describe, expect, it, vi } from "vitest";
import { buildUrl, filterFlights } from "../scraper.ts";
import { parseArgs, runSmokeTest, type SmokeDependencies } from "../scripts/test-scrape.ts";
import type { Flight, Route } from "../types.ts";

const route: Route = {
  name: "GRU to LIS",
  from: "GRU",
  to: "LIS",
  roundTrip: true,
  departureDate: "2026-10-01",
  returnDate: "2026-10-12",
  currency: "USD",
  active: true,
};

const flight = (overrides: Partial<Flight> = {}): Flight => ({
  price: 500,
  airline: "Example Air",
  duration: "4 hr",
  stops: 0,
  depTime: "9:00 AM",
  arrTime: "1:00 PM",
  ...overrides,
});

function dependencies(overrides: Partial<SmokeDependencies> = {}): SmokeDependencies {
  return {
    env: { ANTHROPIC_KEY: "anthropic", TELEGRAM_KEY: "telegram", TELEGRAM_CHAT_ID: "chat" },
    configPath: "config.json",
    screenshotPath: "test-screenshot.png",
    loadEnvFile: vi.fn(),
    filesystem: {
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({ routes: [route] })),
      writeFileSync: vi.fn(),
    },
    scraper: {
      buildUrl,
      captureFlightsScreenshot: vi.fn().mockImplementation(async (_route, { log }) => {
        log("Sorted by cheapest");
        log("Expanded additional flights");
        return Buffer.from("png");
      }),
      extractFlightsFromScreenshot: vi
        .fn()
        .mockResolvedValue({ flights: [flight()], rawText: "[]", parseError: null }),
      filterFlights,
    },
    sender: vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" }),
    output: { log: vi.fn(), error: vi.fn() },
    now: vi.fn().mockReturnValue(100),
    ...overrides,
  };
}

async function captureFailure(operation: Promise<unknown>): Promise<Error & { result: unknown }> {
  try {
    await operation;
  } catch (error) {
    return error as Error & { result: unknown };
  }
  throw new Error("Expected operation to fail");
}

describe("parseArgs", () => {
  it("parses every supported flag and route name", () => {
    expect(parseArgs(["GRU to LIS", "--json", "--no-send", "-v"])).toEqual({
      routeName: "GRU to LIS",
      json: true,
      noSend: true,
      verbose: true,
    });
  });

  it("preserves invalid option and extra route argument errors", () => {
    expect(() => parseArgs(["--other"])).toThrow("Unknown option: --other");
    expect(() => parseArgs(["one", "two"])).toThrow("Unexpected argument: two");
  });
});

describe("runSmokeTest", () => {
  it("emits the complete result stages, saves screenshot, and skips Telegram with --no-send", async () => {
    const deps = dependencies();
    const result = await runSmokeTest(parseArgs(["--json", "--no-send"]), deps);

    expect(result).toMatchObject({
      ok: true,
      route: { name: "GRU to LIS", url: expect.stringContaining("GRU") },
      screenshot: { path: "test-screenshot.png", bytes: 3, saved: true },
      filters: { extracted: 1, passed: 1 },
      telegram: { status: "skipped", chatId: null },
    });
    expect(result.stages.map((stage) => [stage.name, stage.status])).toEqual([
      ["page", "ok"],
      ["sort", "ok"],
      ["expand", "ok"],
      ["screenshot", "ok"],
      ["extraction", "ok"],
      ["filters", "ok"],
      ["telegram", "warn"],
    ]);
    expect(deps.filesystem!.writeFileSync).toHaveBeenCalledWith(
      "test-screenshot.png",
      Buffer.from("png"),
    );
    expect(deps.sender).not.toHaveBeenCalled();
  });

  it("preserves human output and sends the preview through the injected sender", async () => {
    const deps = dependencies();
    const result = await runSmokeTest(parseArgs([]), deps);

    expect(result.telegram).toMatchObject({
      status: "sent",
      chatId: "chat",
      preview: expect.stringContaining("[TEST]"),
    });
    expect(deps.sender).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "telegram",
        chatId: "chat",
        message: expect.stringContaining("Example Air"),
      }),
    );
    expect(deps.output!.log).toHaveBeenCalledWith(expect.stringContaining("flightbot smoke test"));
  });

  it("rejects missing config, keys, and selected active routes before scraping", async () => {
    await expect(
      runSmokeTest(
        parseArgs([]),
        dependencies({
          filesystem: {
            readFileSync: vi.fn(() => {
              throw new Error("missing config");
            }),
            writeFileSync: vi.fn(),
          },
        }),
      ),
    ).rejects.toThrow("missing config");
    await expect(runSmokeTest(parseArgs([]), dependencies({ env: {} }))).rejects.toThrow(
      "ANTHROPIC_KEY is not set",
    );
    await expect(runSmokeTest(parseArgs(["other"]), dependencies())).rejects.toThrow(
      'No active route named "other" found.',
    );
  });

  it("retains extraction parse errors and distinguishes no extraction from filtered empty results", async () => {
    const parseDeps = dependencies();
    parseDeps.scraper!.extractFlightsFromScreenshot = vi
      .fn()
      .mockResolvedValue({ flights: [], rawText: "not json", parseError: new Error("bad JSON") });
    const parseError = await captureFailure(runSmokeTest(parseArgs(["--no-send"]), parseDeps));
    expect(parseError.message).toBe("Failed to parse Claude response as JSON.");
    expect(parseError.result).toMatchObject({ rawText: "not json", filters: { extracted: 0 } });

    const emptyDeps = dependencies();
    emptyDeps.scraper!.extractFlightsFromScreenshot = vi
      .fn()
      .mockResolvedValue({ flights: [], rawText: "[]", parseError: null });
    const emptyError = await captureFailure(runSmokeTest(parseArgs(["--no-send"]), emptyDeps));
    expect(emptyError.message).toBe(
      "No flights passed filters. Nothing was extracted from the page.",
    );
    expect(emptyError.result).toMatchObject({
      filters: { extracted: 0, passed: 0 },
      cheapestSeen: null,
    });

    const filteredDeps = dependencies();
    filteredDeps.filesystem!.readFileSync = vi
      .fn()
      .mockReturnValue(JSON.stringify({ routes: [{ ...route, maxBudget: 100 }] }));
    const filteredError = await captureFailure(
      runSmokeTest(parseArgs(["--no-send"]), filteredDeps),
    );
    expect(filteredError.message).toContain("Cheapest seen: $ 500");
    expect(filteredError.result).toMatchObject({
      filters: { extracted: 1, passed: 0 },
      cheapestSeen: { price: 500 },
    });
  });

  it("preserves scraper and Telegram failures in the attached result", async () => {
    const scraperDeps = dependencies();
    scraperDeps.scraper!.captureFlightsScreenshot = vi
      .fn()
      .mockRejectedValue(new Error("browser failed"));
    const scraperError = await captureFailure(runSmokeTest(parseArgs(["--no-send"]), scraperDeps));
    expect(scraperError.message).toBe("browser failed");
    expect(scraperError.result).toMatchObject({
      stages: [expect.objectContaining({ name: "page", status: "err", detail: "browser failed" })],
    });

    const telegramDeps = dependencies({
      sender: vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "retry" }),
    });
    const telegramError = await captureFailure(runSmokeTest(parseArgs([]), telegramDeps));
    expect(telegramError.message).toBe("Telegram error 429: retry");
    expect(telegramError.result).toMatchObject({ telegram: { status: "failed", chatId: "chat" } });
  });
});
