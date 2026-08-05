import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as ui from "../../ui.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SECTION_RE = /^__(CONTAINER|RUNS|BEST|ISSUE_COUNT|ISSUES|PRICES|END)__$/;

function sectionsFrom(input) {
  const sections = {};
  let current = null;
  for (const line of input.split("\n")) {
    const match = line.match(SECTION_RE);
    if (match) {
      current = match[1];
      if (current !== "END") sections[current] = [];
      continue;
    }
    if (current && current !== "END") sections[current].push(line);
  }
  return sections;
}

function timestamp(line) {
  const match = line.match(/^\[([^\]]+)]/);
  if (!match) return null;
  const value = new Date(match[1]);
  return Number.isNaN(value.getTime()) ? null : value;
}

function ago(value, now = new Date()) {
  if (!value) return "never";
  const seconds = Math.max(0, Math.round((now - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function nextRun(schedule, now = new Date()) {
  const match = String(schedule).match(/^0 ([\d,]+) \* \* \*$/);
  if (!match) return schedule;
  const hours = match[1].split(",").map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const nextHour = hours.find((hour) => hour > now.getHours()) ?? hours[0];
  if (nextHour === undefined) return schedule;
  return String(nextHour).padStart(2, "0") + ":00";
}

function parseJson(lines, fallback) {
  try {
    return JSON.parse(lines.join("\n"));
  } catch {
    return fallback;
  }
}

function routeFromIssue(line) {
  return line.match(/^\[[^\]]+]\s+\[([^\]]+)]/)?.[1] ?? null;
}

const input = fs.readFileSync(0, "utf8");
const sections = sectionsFrom(input);
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const prices = parseJson(sections.PRICES ?? [], {});
const bestByRoute = {};
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
const lastStart = timestamp(startLines.at(-1));
const lastComplete = timestamp(completeLines.at(-1));
const lastRun = lastComplete ?? lastStart;

const issueLines = (sections.ISSUES ?? []).filter(Boolean);
const lastRunIssues = lastStart
  ? issueLines.filter((line) => {
      const value = timestamp(line);
      return value && value >= lastStart;
    })
  : [];
const incompleteRun = lastStart && (!lastComplete || lastStart > lastComplete);
const verdict = !isUp ? "DOWN" : (incompleteRun || lastRunIssues.length > 0) ? "DEGRADED" : "HEALTHY";
const verdictStyle = verdict === "HEALTHY" ? ui.c.ok : verdict === "DEGRADED" ? ui.c.warn : ui.c.err;

console.log();
console.log(ui.title("flightbot", `${verdictStyle(verdict)}        last run ${ago(lastRun)} ${ui.glyph.dot} next ${nextRun(config.schedule)}`));
console.log();

const rows = config.routes.map((route) => {
  const state = prices[route.name] ?? {};
  const seen = state.lastSeenPrice ?? bestByRoute[route.name]?.price ?? null;
  const seenAt = state.lastSeenAt
    ? new Date(state.lastSeenAt)
    : bestByRoute[route.name]?.at ?? null;
  let status = route.active ? "no data" : "inactive";
  if (seen !== null && route.maxBudget !== null && route.maxBudget !== undefined) {
    status = seen <= route.maxBudget ? "under budget" : "over budget";
  } else if (seen !== null) {
    status = "tracking";
  }
  return {
    route: route.name,
    best: ui.money(seen, route.currency),
    seen: ago(seenAt),
    budget: ui.money(route.maxBudget ?? null, route.currency),
    status,
  };
});

console.log(ui.table([
  { key: "route", header: "route" },
  { key: "best", header: "best", align: "right" },
  { key: "seen", header: "last seen", align: "right" },
  { key: "budget", header: "budget", align: "right" },
  { key: "status", header: "status" },
], rows));

const issueCount = Number.parseInt((sections.ISSUE_COUNT ?? ["0"]).find(Boolean) ?? "0", 10) || 0;
console.log();
if (issueCount === 0) {
  console.log(ui.status("ok", "no issues in results.log"));
} else {
  console.log(ui.status("warn", `${issueCount} issue${issueCount === 1 ? "" : "s"} in results.log`));
  for (const line of issueLines.slice(-5)) {
    const message = line.replace(/^\[[^\]]+]\s*/, "").replace(/^\[[^\]]+]\s*/, "");
    const route = routeFromIssue(line);
    const when = ago(timestamp(line));
    const meta = [route, when].filter(Boolean).join(", ");
    console.log(`  ${ui.truncate(message, Math.max(20, ui.width() - 4 - ui.displayWidth(meta)))}${meta ? ui.c.dim(`  (${meta})`) : ""}`);
  }
}

if (!isUp) {
  console.log();
  console.log(ui.status("err", `container ${containerStatus}`));
}
