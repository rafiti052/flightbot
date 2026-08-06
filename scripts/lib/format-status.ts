import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ui from "../../ui.ts";
import type { ConfigFile } from "../../types.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultConfigPath = path.join(root, "config.json");
const sectionRe = /^__(CONTAINER|RUNS|BEST|ISSUE_COUNT|ISSUES|PRICES|END)__$/;

type Sections = Partial<
  Record<"CONTAINER" | "RUNS" | "BEST" | "ISSUE_COUNT" | "ISSUES" | "PRICES", string[]>
>;
type Clock = () => Date;

export function sectionsFrom(input: string): Sections {
  const sections: Sections = {};
  let current: keyof Sections | null = null;
  for (const line of input.split("\n")) {
    const match = line.match(sectionRe);
    if (match) {
      current = match[1] === "END" ? null : (match[1] as keyof Sections);
      if (current) sections[current] = [];
      continue;
    }
    if (current) sections[current]?.push(line);
  }
  return sections;
}

function timestamp(line: string): Date | null {
  const match = line.match(/^\[([^\]]+)]/);
  if (!match) return null;
  const value = new Date(match[1]);
  return Number.isNaN(value.getTime()) ? null : value;
}

function ago(value: Date | null, now: Date): string {
  if (!value) return "never";
  const seconds = Math.max(0, Math.round((now.getTime() - value.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function nextRun(schedule: string, now: Date): string {
  const match = String(schedule).match(/^0 ([\d,]+) \* \* \*$/);
  if (!match) return schedule;
  const hours = match[1]
    .split(",")
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const nextHour = hours.find((hour) => hour > now.getHours()) ?? hours[0];
  if (nextHour === undefined) return schedule;
  return `${String(nextHour).padStart(2, "0")}:00`;
}

function parseJson(lines: string[], fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(lines.join("\n")) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

function routeFromIssue(line: string): string | null {
  return line.match(/^\[[^\]]+]\s+\[([^\]]+)]/)?.[1] ?? null;
}

export function formatStatus({
  sections,
  config,
  clock = () => new Date(),
}: {
  sections: Sections;
  config: ConfigFile;
  clock?: Clock;
}): string {
  const now = clock();
  const prices = parseJson(sections.PRICES ?? [], {});
  const bestByRoute: Record<string, { price: number; at: Date }> = {};
  for (const line of sections.BEST ?? []) {
    const match = line.match(/^\[([^\]]+)]\s+\[([^\]]+)]\s+Best price:\s+([\d.]+)/);
    if (!match) continue;
    bestByRoute[match[2]] = { price: Number(match[3]), at: new Date(match[1]) };
  }

  const containerLine = (sections.CONTAINER ?? []).find(Boolean) ?? "";
  const [, containerStatus = "not found"] = containerLine.split("\t");
  const isUp = /^Up\b/.test(containerStatus);
  const runLines = (sections.RUNS ?? []).filter(Boolean);
  const startLines = runLines.filter((line) => line.includes("=== Bot run started ==="));
  const completeLines = runLines.filter((line) => line.includes("=== Bot run complete ==="));
  const lastStart = timestamp(startLines.at(-1) ?? "");
  const lastComplete = timestamp(completeLines.at(-1) ?? "");
  const lastRun = lastComplete ?? lastStart;
  const issueLines = (sections.ISSUES ?? []).filter(Boolean);
  const lastRunIssues = lastStart
    ? issueLines.filter((line) => {
        const value = timestamp(line);
        return value !== null && value >= lastStart;
      })
    : [];
  const incompleteRun = lastStart !== null && (lastComplete === null || lastStart > lastComplete);
  const verdict = !isUp
    ? "DOWN"
    : incompleteRun || lastRunIssues.length > 0
      ? "DEGRADED"
      : "HEALTHY";
  const verdictStyle =
    verdict === "HEALTHY" ? ui.c.ok : verdict === "DEGRADED" ? ui.c.warn : ui.c.err;
  const lines = [
    "",
    ui.title(
      "flightbot",
      `${verdictStyle(verdict)}        last run ${ago(lastRun, now)} ${ui.glyph.dot} next ${nextRun(config.schedule, now)}`,
    ),
    "",
  ];

  const rows = config.routes.map((route) => {
    const state = (prices[route.name] ?? {}) as Record<string, unknown>;
    const seen = state.lastSeenPrice ?? bestByRoute[route.name]?.price ?? null;
    const seenAt = state.lastSeenAt
      ? new Date(String(state.lastSeenAt))
      : (bestByRoute[route.name]?.at ?? null);
    let status = route.active ? "no data" : "inactive";
    if (seen !== null && route.maxBudget !== null && route.maxBudget !== undefined) {
      status = Number(seen) <= route.maxBudget ? "under budget" : "over budget";
    } else if (seen !== null) status = "tracking";
    return {
      route: route.name,
      best: ui.money(seen, route.currency ?? undefined),
      seen: ago(seenAt, now),
      budget: ui.money(route.maxBudget ?? null, route.currency ?? undefined),
      status,
    };
  });
  lines.push(
    ui.table(
      [
        { key: "route", header: "route" },
        { key: "best", header: "best", align: "right" },
        { key: "seen", header: "last seen", align: "right" },
        { key: "budget", header: "budget", align: "right" },
        { key: "status", header: "status" },
      ],
      rows,
    ),
  );

  const issueCount = Number.parseInt((sections.ISSUE_COUNT ?? ["0"]).find(Boolean) ?? "0", 10) || 0;
  lines.push("");
  if (issueCount === 0) lines.push(ui.status("ok", "no issues in results.log"));
  else {
    lines.push(
      ui.status("warn", `${issueCount} issue${issueCount === 1 ? "" : "s"} in results.log`),
    );
    for (const line of issueLines.slice(-5)) {
      const message = line.replace(/^\[[^\]]+]\s*/, "").replace(/^\[[^\]]+]\s*/, "");
      const route = routeFromIssue(line);
      const when = ago(timestamp(line), now);
      const meta = [route, when].filter(Boolean).join(", ");
      lines.push(
        `  ${ui.truncate(message, Math.max(20, ui.width() - 4 - ui.displayWidth(meta)))}${meta ? ui.c.dim(`  (${meta})`) : ""}`,
      );
    }
  }
  if (!isUp) {
    lines.push("", ui.status("err", `container ${containerStatus}`));
  }
  return lines.join("\n");
}

export function runStatusFormatter({
  input,
  configPath = defaultConfigPath,
  stdout = (value: string) => process.stdout.write(value),
  clock,
}: {
  input: string;
  configPath?: string;
  stdout?: (value: string) => void;
  clock?: Clock;
}): void {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as ConfigFile;
  stdout(`${formatStatus({ sections: sectionsFrom(input), config, clock })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`)
  runStatusFormatter({ input: fs.readFileSync(0, "utf8") });
