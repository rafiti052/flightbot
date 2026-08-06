import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRouteManager } from "../scripts/config-route.ts";

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);

function fixture({ routes = [], prices }: { routes?: unknown[]; prices?: unknown } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-manager-"));
  roots.push(root);
  const configPath = path.join(root, "config.json");
  const pricesPath = path.join(root, "prices.json");
  fs.writeFileSync(configPath, JSON.stringify({ schedule: "0 8 * * *", routes }));
  if (prices !== undefined) fs.writeFileSync(pricesPath, JSON.stringify(prices));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  return {
    configPath,
    pricesPath,
    stdout,
    stderr,
    exits,
    run: (argv: readonly string[]) =>
      runRouteManager({
        argv,
        configPath,
        pricesPath,
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
        exit: (code) => exits.push(code),
      }),
  };
}

describe("route manager CLI contract", () => {
  it("lists routes with price state and treats missing prices as empty", () => {
    const f = fixture({
      routes: [{ name: "GRU → JFK", active: false, maxBudget: 4000, departureDate: "2026-09-10" }],
    });
    expect(f.run(["list"])).toBe(0);
    expect(JSON.parse(f.stdout[0])).toEqual([
      {
        name: "GRU → JFK",
        active: false,
        maxBudget: 4000,
        depart: "2026-09-10",
        return: null,
        lastSeenPrice: null,
        lastAlertPrice: null,
      },
    ]);
  });

  it("adds routes with defaults and optional values", () => {
    const f = fixture();
    expect(f.run(["add", "--from", "gru", "--to", "jfk", "--depart", "2026-09-10"])).toBe(0);
    expect(JSON.parse(f.stdout[0])).toMatchObject({
      totalRoutes: 1,
      added: {
        name: "GRU → JFK",
        from: "GRU",
        to: "JFK",
        roundTrip: false,
        returnDate: null,
        flexDays: 0,
        currency: "BRL",
        maxStops: null,
        maxBudget: null,
        maxDurationHours: null,
        active: true,
      },
    });
    expect(
      f.run([
        "add",
        "--from",
        "GRU",
        "--to",
        "LIS",
        "--depart",
        "2026-10-01",
        "--return",
        "2026-10-12",
        "--budget",
        "4200",
        "--stops",
        "1",
        "--duration",
        "14",
        "--flex",
        "2",
        "--currency",
        "USD",
        "--name",
        "Custom",
      ]),
    ).toBe(0);
    expect(JSON.parse(fs.readFileSync(f.configPath, "utf8")).routes[1]).toMatchObject({
      name: "Custom",
      roundTrip: true,
      returnDate: "2026-10-12",
      maxBudget: 4200,
      maxStops: 1,
      maxDurationHours: 14,
      flexDays: 2,
      currency: "USD",
    });
  });

  it("pauses and resumes the named route only", () => {
    const f = fixture({
      routes: [
        { name: "A", active: true },
        { name: "B", active: true },
      ],
    });
    expect(f.run(["pause", "A"])).toBe(0);
    expect(f.run(["resume", "A"])).toBe(0);
    expect(JSON.parse(fs.readFileSync(f.configPath, "utf8")).routes).toEqual([
      { name: "A", active: true },
      { name: "B", active: true },
    ]);
    expect(JSON.parse(f.stdout[1])).toEqual({ route: "A", active: true });
  });

  it("resets only the named route price history and reports absent history", () => {
    const f = fixture({
      routes: [{ name: "A" }, { name: "B" }],
      prices: { A: { lastSeenPrice: 10 }, B: { lastSeenPrice: 20 } },
    });
    expect(f.run(["reset", "A"])).toBe(0);
    expect(JSON.parse(fs.readFileSync(f.pricesPath, "utf8"))).toEqual({ B: { lastSeenPrice: 20 } });
    expect(JSON.parse(f.stdout[0])).toEqual({
      route: "A",
      cleared: true,
      previous: { lastSeenPrice: 10 },
    });
    expect(f.run(["reset", "B"])).toBe(0);
    expect(f.run(["reset", "B"])).toBe(0);
    expect(JSON.parse(f.stdout[2])).toEqual({
      route: "B",
      cleared: false,
      reason: "no price history",
    });
  });

  it("preserves errors, stderr routing, and nonzero exits", () => {
    const f = fixture({ routes: [{ name: "A" }] });
    for (const [argv, message] of [
      [["wat"], 'unknown command "wat". Use: list | add | pause | resume | reset'],
      [["add", "--from", "GRU"], "--to is required"],
      [["add", "--from", "GRU", "--to", "JFK", "--depart"], "Flag --depart is missing a value"],
      [["add", "oops", "x"], 'Expected a --flag, got "oops"'],
      [
        ["add", "--from", "GRU", "--to", "JFK", "--depart", "bad"],
        '--depart must be YYYY-MM-DD, got "bad"',
      ],
      [
        ["add", "--from", "GRU", "--to", "JFK", "--depart", "2026-09-10", "--budget", "no"],
        '--budget must be a number, got "no"',
      ],
      [
        ["add", "--from", "A", "--to", "B", "--depart", "2026-09-10", "--name", "A"],
        'A route named "A" already exists. Use a different --name or remove it first.',
      ],
      [["pause"], 'usage: config-route.ts pause "Route Name"'],
      [["resume"], 'usage: config-route.ts resume "Route Name"'],
      [["reset"], 'usage: config-route.ts reset "Route Name"'],
      [["resume", "missing"], 'No route named "missing". Available: "A"'],
    ] as const) {
      expect(f.run(argv)).toBe(1);
      expect(f.stderr.at(-1)).toBe(`error: ${message}\n`);
    }
    expect(f.exits).toEqual(Array(11).fill(1));
  });

  it("rejects malformed config and prices JSON without mutation", () => {
    const f = fixture();
    fs.writeFileSync(f.configPath, "{");
    expect(f.run(["list"])).toBe(1);
    expect(f.stderr[0]).toMatch(/^error: config.json is malformed JSON:/);
    fs.writeFileSync(f.configPath, JSON.stringify({ routes: [] }));
    fs.writeFileSync(f.pricesPath, "{");
    expect(f.run(["list"])).toBe(1);
    expect(f.stderr[1]).toMatch(/^error: prices.json is malformed JSON:/);
  });
});
