import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatStatus, runStatusFormatter, sectionsFrom } from "../scripts/lib/format-status.ts";
import type { ConfigFile } from "../types.ts";

const now = new Date("2026-08-06T12:00:00Z");
const config: ConfigFile = {
  schedule: "0 8,14 * * *",
  routes: [
    {
      name: "GRU → JFK",
      from: "GRU",
      to: "JFK",
      roundTrip: false,
      departureDate: "2026-09-10",
      currency: "BRL",
      maxBudget: 4000,
      active: true,
    },
    {
      name: "GRU → LIS",
      from: "GRU",
      to: "LIS",
      roundTrip: false,
      departureDate: "2026-09-10",
      currency: "USD",
      maxBudget: null,
      active: false,
    },
  ],
};
const captured = (parts: Record<string, string>) =>
  Object.entries(parts)
    .flatMap(([name, value]) => [`__${name}__`, value])
    .concat("__END__")
    .join("\n");
const render = (parts: Record<string, string>, overrides: Partial<ConfigFile> = {}) =>
  formatStatus({
    sections: sectionsFrom(captured(parts)),
    config: { ...config, ...overrides },
    clock: () => now,
  });
const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);

describe("status formatter contract", () => {
  it("parses captured sections and renders a healthy non-TTY status", () => {
    expect(
      sectionsFrom(
        captured({
          CONTAINER: "flightbot\tUp 2 hours",
          RUNS: "[2026-08-06T11:00:00Z] === Bot run started ===\n[2026-08-06T11:01:00Z] === Bot run complete ===",
          PRICES: '{"GRU → JFK":{"lastSeenPrice":3500,"lastSeenAt":"2026-08-06T11:00:00Z"}}',
        }),
      ),
    ).toMatchObject({ CONTAINER: ["flightbot\tUp 2 hours"] });
    expect(
      render({
        CONTAINER: "flightbot\tUp 2 hours",
        RUNS: "[2026-08-06T11:00:00Z] === Bot run started ===\n[2026-08-06T11:01:00Z] === Bot run complete ===",
        PRICES: '{"GRU → JFK":{"lastSeenPrice":3500,"lastSeenAt":"2026-08-06T11:00:00Z"}}',
      }),
    ).toContain("flightbot  HEALTHY        last run 59m ago · next 14:00");
    expect(
      render({
        CONTAINER: "flightbot\tUp",
        PRICES: '{"GRU → JFK":{"lastSeenPrice":3500,"lastSeenAt":"2026-08-06T11:00:00Z"}}',
      }),
    ).toContain("GRU → JFK  R$ 3.500");
  });

  it("renders degraded incomplete runs and issues from the last run", () => {
    const output = render({
      CONTAINER: "flightbot\tUp",
      RUNS: "[2026-08-06T11:59:00Z] === Bot run started ===",
      ISSUE_COUNT: "2",
      ISSUES: "[2026-08-06T11:59:30Z] [GRU → JFK] scrape failed",
    });
    expect(output).toContain("DEGRADED        last run 1m ago");
    expect(output).toContain("⚠ 2 issues in results.log");
    expect(output).toContain("scrape failed  (GRU → JFK, 30s ago)");
  });

  it("renders down containers, budgets, inactive routes, and BEST fallback", () => {
    const output = render({
      CONTAINER: "flightbot\tExited (1)",
      BEST: "[2026-08-06T11:00:00Z] [GRU → LIS] Best price: 800",
      PRICES: "{}",
    });
    expect(output).toContain("DOWN        last run never · next 14:00");
    expect(output).toContain("GRU → LIS  $ 800");
    expect(output).toContain("tracking");
    expect(output).toContain("✗ container Exited (1)");
  });

  it("renders inactive routes without price data", () => {
    expect(render({ CONTAINER: "flightbot\tUp", PRICES: "{}" })).toContain(
      "GRU → LIS     —      never         —  inactive",
    );
  });

  it("keeps malformed prices and malformed log records non-fatal", () => {
    const output = render(
      {
        CONTAINER: "flightbot\tUp",
        BEST: "not a best record",
        PRICES: "{",
        ISSUE_COUNT: "bad",
        ISSUES: "malformed issue",
      },
      { schedule: "custom" },
    );
    expect(output).toContain("HEALTHY        last run never · next custom");
    expect(output).toContain("no data");
    expect(output).toContain("✓ no issues in results.log");
  });

  it("keeps config I/O in the wrapper and emits the formatter's non-TTY text", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "format-status-"));
    roots.push(root);
    const configPath = path.join(root, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config));
    const output: string[] = [];
    const input = captured({ CONTAINER: "flightbot\tUp", PRICES: "{}" });
    runStatusFormatter({
      input,
      configPath,
      stdout: (value) => output.push(value),
      clock: () => now,
    });
    expect(output).toEqual([
      `${formatStatus({ sections: sectionsFrom(input), config, clock: () => now })}\n`,
    ]);
    expect(output[0]).not.toContain("\x1b[");
  });
});
