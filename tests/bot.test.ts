import { describe, expect, it, vi } from "vitest";
import type { Flight, Route, RuntimeConfig } from "../types.ts";
import { dateVariants, evaluateAlert, loadConfig, main, run, runWithLock } from "../bot.ts";

const route: Route = {
  name: "GRU-LIS",
  from: "GRU",
  to: "LIS",
  roundTrip: true,
  departureDate: "2026-10-01",
  returnDate: "2026-10-12",
  currency: "BRL",
  maxBudget: 500,
  active: true,
};
const config: RuntimeConfig = {
  schedule: "0 9 * * *",
  routes: [route],
  anthropic: { apiKey: "anthropic" },
  telegram: { token: "telegram", chatId: "chat" },
};
const flight = (price: number): Flight => ({
  price,
  airline: "Example Air",
  duration: "8 hr",
  stops: 0,
  depTime: "10:00",
  arrTime: "18:00",
});
const runtime = (scrape = vi.fn().mockResolvedValue([flight(450)])) => ({
  scrape,
  send: vi.fn().mockResolvedValue(true),
  sleep: vi.fn().mockResolvedValue(undefined),
  random: () => 0,
  now: () => Date.UTC(2026, 0, 2),
  log: vi.fn(),
  exists: () => false,
  readFile: () => "",
  writeFile: vi.fn(),
  appendFile: vi.fn(),
});

describe("bot runtime contracts", () => {
  it("hydrates config and preserves missing, unreadable, malformed, and missing-secret errors", () => {
    const env = { ANTHROPIC_KEY: "a", TELEGRAM_KEY: "t", TELEGRAM_CHAT_ID: "c" };
    expect(
      loadConfig({
        configPath: "/tmp/config.json",
        exists: () => true,
        readFile: () => JSON.stringify({ schedule: "0 9 * * *", routes: [] }),
        env,
      }),
    ).toMatchObject({ anthropic: { apiKey: "a" }, telegram: { token: "t", chatId: "c" } });
    expect(() => loadConfig({ configPath: "/missing", exists: () => false, env })).toThrow(
      "config.json not found at /missing. Please create it before running the bot.",
    );
    expect(() =>
      loadConfig({
        exists: () => true,
        readFile: () => {
          throw new Error("denied");
        },
        env,
      }),
    ).toThrow("Failed to read config.json: denied");
    expect(() => loadConfig({ exists: () => true, readFile: () => "{", env })).toThrow(
      "config.json is malformed JSON:",
    );
    expect(() => loadConfig({ exists: () => true, readFile: () => "{}", env: {} })).toThrow(
      "ANTHROPIC_KEY is not set (check .env)",
    );
  });

  it("expands flex dates together for round trips and leaves one-way return undefined", () => {
    expect(
      dateVariants({ ...route, flexDays: 1 }).map((item) => [
        item.departureDate,
        item.returnDate,
        item._dateLabel,
      ]),
    ).toEqual([
      ["2026-09-30", "2026-10-11", "dep 2026-09-30"],
      ["2026-10-01", "2026-10-12", "dep 2026-10-01"],
      ["2026-10-02", "2026-10-13", "dep 2026-10-02"],
    ]);
    expect(
      dateVariants({ ...route, roundTrip: false, returnDate: undefined, flexDays: 1 }).every(
        (item) => item.returnDate === undefined,
      ),
    ).toBe(true);
  });

  it("selects every alert branch and boundary", () => {
    expect(evaluateAlert({ ...route, maxBudget: null }, flight(500), undefined)).toBe("first");
    expect(
      evaluateAlert({ ...route, maxBudget: null }, flight(500), { lastSeenPrice: 500 }),
    ).toBeNull();
    expect(evaluateAlert({ ...route, maxBudget: null }, flight(499), { lastSeenPrice: 500 })).toBe(
      "first",
    );
    expect(evaluateAlert(route, flight(501), undefined)).toBeNull();
    expect(evaluateAlert(route, flight(500), undefined)).toBe("first");
    expect(evaluateAlert(route, flight(499), { lastAlertPrice: 500 })).toBe("lower");
    expect(evaluateAlert(route, flight(500), { lastAlertPrice: 500 })).toBeNull();
    expect(evaluateAlert(route, flight(500), { lastAlertPrice: 450 })).toBe("returned");
  });

  it("skips inactive routes, records stable alert data, and sends the unchanged Telegram payload", async () => {
    const deps = runtime();
    const outcomes = await run({ ...config, routes: [{ ...route, active: false }, route] }, deps);
    expect(outcomes).toHaveLength(1);
    expect(deps.scrape).toHaveBeenCalledTimes(1);
    expect(deps.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"lastAlertPrice": 450'),
    );
    expect(deps.appendFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"alertType":"first"'),
    );
    expect(deps.send).toHaveBeenCalledWith(
      "telegram",
      "chat",
      expect.stringContaining("Good price found — GRU-LIS"),
    );
    expect(deps.sleep).toHaveBeenCalledWith(3000);
  });

  it("updates last seen silently and reports scrape errors and no-results without sending", async () => {
    const silent = runtime(vi.fn().mockResolvedValue([flight(600)]));
    await run(config, silent);
    expect(silent.send).not.toHaveBeenCalled();
    expect(silent.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"lastSeenPrice": 600'),
    );
    const failed = runtime(vi.fn().mockRejectedValue(new Error("scrape failed")));
    const outcomes = await run(config, failed);
    expect(outcomes[0]).toMatchObject({
      best: null,
      alertType: null,
      error: expect.objectContaining({ message: "scrape failed" }),
    });
    expect(failed.send).not.toHaveBeenCalled();
    expect(failed.log).toHaveBeenCalledWith(
      expect.stringContaining("No results across all date variants, skipping"),
    );
  });

  it("skips a fresh lock, recovers a stale lock, and catches run failures", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runtime(vi.fn().mockReturnValue(pending));
    const running = runWithLock(config, "startup", { ...first, now: () => 1000 });
    await Promise.resolve();
    await runWithLock(config, "schedule", { ...runtime(), now: () => 2000, log: first.log });
    expect(first.log).toHaveBeenCalledWith(expect.stringContaining("Skipping schedule run"));
    const stale = runtime(vi.fn().mockResolvedValue([flight(450)]));
    await runWithLock(config, "schedule", { ...stale, now: () => 6 * 60 * 60 * 1000 + 1001 });
    expect(stale.log).toHaveBeenCalledWith(expect.stringContaining("Previous run lock was stale"));
    release?.();
    await running;
    const bad = runtime();
    await runWithLock(config, "startup", {
      ...bad,
      writeFile: () => {
        throw new Error("disk");
      },
    });
    expect(bad.log).toHaveBeenCalledWith(
      expect.stringContaining("Initial run failed: Error: disk"),
    );
  });

  it("keeps imports inert and only loads environment, schedules, and starts work through main", () => {
    const deps = runtime();
    const loadEnvFile = vi.fn();
    const schedule = vi.fn();
    expect(typeof main).toBe("function");
    main({
      ...deps,
      loadEnvFile,
      schedule,
      exists: () => true,
      readFile: () => JSON.stringify({ schedule: "0 9 * * *", routes: [] }),
      env: { ANTHROPIC_KEY: "a", TELEGRAM_KEY: "t", TELEGRAM_CHAT_ID: "c" },
    });
    expect(loadEnvFile).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith("0 9 * * *", expect.any(Function));
    expect(deps.log).toHaveBeenCalledWith("Bot started. Schedule: 0 9 * * *");
  });
});
