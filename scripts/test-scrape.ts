/**
 * Smoke test: scrapes one active route using Claude vision and optionally sends
 * a Telegram message. It shares the production scrape path in scraper.js.
 *
 * Local:      node scripts/test-scrape.js ["Route Name"] [--no-send] [-v]
 * Structured: node scripts/test-scrape.js ["Route Name"] --json [--no-send]
 * Container:  docker exec flightbot node scripts/test-scrape.js --json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildUrl,
  captureFlightsScreenshot,
  extractFlightsFromScreenshot,
  filterFlights,
} from "../scraper.ts";
import * as ui from "../ui.ts";
import type { Flight, FlightExtractionResult, Route } from "../types.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOT_PATH = path.join(ROOT, "test-screenshot.png");

export interface SmokeOptions {
  json: boolean;
  noSend: boolean;
  verbose: boolean;
  routeName: string | null;
}

type Stage = {
  name: string;
  label: string;
  status: string;
  durationMs: number | null;
  detail?: string;
};

export interface SmokeResult {
  ok: boolean;
  route: {
    name: string;
    from: string;
    to: string;
    departureDate: string;
    returnDate: string | null;
    url: string;
  } | null;
  stages: Stage[];
  flights: Flight[];
  filters: {
    maxBudget: number | null;
    maxStops: number | null;
    maxDurationHours: number | null;
    passed: number;
    extracted: number;
  } | null;
  telegram: { status: string; chatId: string | null; preview?: string } | null;
  screenshot: { path: string; bytes: number; saved: boolean } | null;
  rawText: string;
  error: string | null;
  durationMs: number;
  cheapestSeen?: Flight | null;
}

type Output = Pick<Console, "log" | "error">;
type SmokeFileSystem = Pick<typeof fs, "readFileSync" | "writeFileSync">;
type Sender = (input: {
  token: string;
  chatId: string;
  message: string;
}) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface SmokeDependencies {
  configPath?: string;
  screenshotPath?: string;
  envPath?: string;
  env?: NodeJS.ProcessEnv;
  filesystem?: SmokeFileSystem;
  scraper?: {
    buildUrl: typeof buildUrl;
    captureFlightsScreenshot: typeof captureFlightsScreenshot;
    extractFlightsFromScreenshot: typeof extractFlightsFromScreenshot;
    filterFlights: typeof filterFlights;
  };
  sender?: Sender;
  output?: Output;
  loadEnvFile?: (path: string) => void;
  now?: () => number;
}

export function parseArgs(argv: string[]): SmokeOptions {
  const options: SmokeOptions = { json: false, noSend: false, verbose: false, routeName: null };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "--no-send") options.noSend = true;
    else if (arg === "-v" || arg === "--verbose") options.verbose = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (options.routeName === null) options.routeName = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}

function dateLabel(dateStr: string | null | undefined): string {
  if (!dateStr) return "N/A";
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatDateLabel(dateStr: string | null | undefined): string {
  return dateLabel(dateStr);
}

function stopLabel(stops: number | null | undefined): string {
  if (stops === 0) return "nonstop";
  if (stops === null || stops === undefined) return "unknown";
  return `${stops} stop${stops === 1 ? "" : "s"}`;
}

function filterLabel(
  filters: { maxStops: number | null; maxDurationHours: number | null; maxBudget: number | null },
  currency: string,
): string {
  const parts = [];
  if (filters.maxStops !== null)
    parts.push(filters.maxStops === 0 ? "nonstop" : `≤${filters.maxStops} stops`);
  if (filters.maxDurationHours !== null) parts.push(`≤${filters.maxDurationHours}h`);
  if (filters.maxBudget !== null) parts.push(`≤ ${ui.money(filters.maxBudget, currency)}`);
  return parts.length > 0 ? parts.join(", ") : "no limits";
}

function flightRows(flights: Flight[], currency: string) {
  return flights.map((flight, index) => ({
    number: String(index + 1),
    price: ui.money(flight.price, currency),
    airline: flight.airline ?? "—",
    stops: stopLabel(flight.stops),
    duration: flight.duration ?? "—",
    depart: flight.depTime ?? "—",
    arrive: flight.arrTime ?? "—",
  }));
}

function renderFlights(flights: Flight[], currency: string, output: Output = console): void {
  output.log(
    ui.table(
      [
        { key: "number", header: "#", align: "right" },
        { key: "price", header: "price", align: "right" },
        { key: "airline", header: "airline" },
        { key: "stops", header: "stops" },
        { key: "duration", header: "duration", align: "right" },
        { key: "depart", header: "depart", align: "right" },
        { key: "arrive", header: "arrive", align: "right" },
      ],
      flightRows(flights, currency),
    ),
  );
}

function formatMessage(route: Route, best: Flight): string {
  const currency = route.currency ?? "USD";
  const stops =
    best.stops === 0
      ? "Nonstop"
      : `${best.stops ?? "unknown"} stop${(best.stops ?? 0) > 1 ? "s" : ""}`;
  const time =
    best.depTime && best.arrTime
      ? `${best.depTime} → ${best.arrTime}  (${best.duration})`
      : (best.duration ?? "N/A");
  const departure = formatDateLabel(route.departureDate);
  const returnDate = route.returnDate ? formatDateLabel(route.returnDate) : null;
  const dates = route.roundTrip && returnDate ? `${departure} → ${returnDate}` : departure;

  return (
    `🟢 [TEST] Good price found — ${route.name}\n\n` +
    `✈️  ${best.airline ?? "Unknown airline"}  ·  ${stops}\n` +
    `📅  ${dates}\n` +
    `🕐  ${time}\n` +
    `💰  ${currency} ${(best.price ?? 0).toLocaleString("pt-BR")}\n\n` +
    `🔗 [Search on Google Flights](${buildUrl(route)})`
  );
}

function printStage(stage: Stage, output: Output = console): void {
  const detail = stage.detail ? `  ${ui.c.dim(stage.detail)}` : "";
  const timing = stage.durationMs === null ? "" : `  ${ui.c.dim(ui.dur(stage.durationMs))}`;
  output.log(`${ui.status(stage.status, stage.label)}${detail}${timing}`);
}

const defaultSender: Sender = async ({ token, chatId, message }) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown",
      disable_web_page_preview: false,
    }),
  });
  return response;
};

export async function runSmokeTest(
  options: SmokeOptions,
  dependencies: SmokeDependencies = {},
): Promise<SmokeResult> {
  const env = dependencies.env ?? process.env;
  const filesystem = dependencies.filesystem ?? fs;
  const scraper = dependencies.scraper ?? {
    buildUrl,
    captureFlightsScreenshot,
    extractFlightsFromScreenshot,
    filterFlights,
  };
  const output = dependencies.output ?? console;
  const sender = dependencies.sender ?? defaultSender;
  const configPath = dependencies.configPath ?? path.join(ROOT, "config.json");
  const screenshotPath = dependencies.screenshotPath ?? SCREENSHOT_PATH;
  const envPath = dependencies.envPath ?? path.join(ROOT, ".env");
  const now = dependencies.now ?? Date.now;
  try {
    (dependencies.loadEnvFile ?? process.loadEnvFile)(envPath);
  } catch {
    // Fall back to environment variables injected by the container.
  }

  const config = JSON.parse(filesystem.readFileSync(configPath, "utf-8")) as { routes: Route[] };
  if (!env.ANTHROPIC_KEY) throw new Error("ANTHROPIC_KEY is not set (check .env)");
  if (!options.noSend && !env.TELEGRAM_KEY) throw new Error("TELEGRAM_KEY is not set (check .env)");
  if (!options.noSend && !env.TELEGRAM_CHAT_ID)
    throw new Error("TELEGRAM_CHAT_ID is not set (check .env)");

  const route = options.routeName
    ? config.routes.find((candidate) => candidate.active && candidate.name === options.routeName)
    : config.routes.find((candidate) => candidate.active);
  if (!route) {
    throw new Error(
      options.routeName
        ? `No active route named "${options.routeName}" found.`
        : "No active route found in config.json",
    );
  }

  const startedAt = now();
  const result: SmokeResult = {
    ok: false,
    route: {
      name: route.name,
      from: route.from,
      to: route.to,
      departureDate: route.departureDate,
      returnDate: route.returnDate ?? null,
      url: scraper.buildUrl(route),
    },
    stages: [],
    flights: [],
    filters: {
      maxBudget: route.maxBudget ?? null,
      maxStops: route.maxStops ?? null,
      maxDurationHours: route.maxDurationHours ?? null,
      passed: 0,
      extracted: 0,
    },
    telegram: { status: options.noSend ? "skipped" : "pending", chatId: null },
    screenshot: { path: screenshotPath, bytes: 0, saved: false },
    rawText: "",
    error: null,
    durationMs: 0,
  };

  if (!options.json) {
    output.log();
    output.log(ui.title("flightbot smoke test"));
    output.log(
      ui.kv(
        "route",
        `${route.name}        dates  ${dateLabel(route.departureDate)} → ${dateLabel(route.returnDate)}`,
      ),
    );
    output.log();
  }

  const scrapeMessages: string[] = [];
  const scrapeStartedAt = now();
  const progress = options.json ? null : ui.spinner("loading Google Flights");
  let screenshot;
  try {
    screenshot = await scraper.captureFlightsScreenshot(route, {
      log: (message) => scrapeMessages.push(message),
    });
    result.stages.push({
      name: "page",
      label: "page loaded",
      status: "ok",
      durationMs: now() - scrapeStartedAt,
    });
    progress?.succeed("page loaded");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.stages.push({
      name: "page",
      label: "page load",
      status: "err",
      durationMs: now() - scrapeStartedAt,
      detail: message,
    });
    progress?.fail(`page load  ${message}`);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { result });
  }

  const cardTimeout = scrapeMessages.find((message) =>
    message.startsWith("Timed out waiting for flight cards"),
  );
  if (cardTimeout) {
    const timeoutStage = {
      name: "flight_cards",
      label: "flight cards timed out",
      status: "warn",
      durationMs: null,
      detail: cardTimeout,
    };
    result.stages.push(timeoutStage);
    if (!options.json) printStage(timeoutStage, output);
  }

  const sorted = scrapeMessages.includes("Sorted by cheapest");
  const sortStage = {
    name: "sort",
    label: sorted ? "sorted by cheapest" : "default sorting used",
    status: sorted ? "ok" : "warn",
    durationMs: null,
  };
  result.stages.push(sortStage);

  const expanded = scrapeMessages.includes("Expanded additional flights");
  const expandStage = {
    name: "expand",
    label: expanded ? "expanded more flights" : "no more-flights control",
    status: expanded ? "ok" : "warn",
    durationMs: null,
  };
  result.stages.push(expandStage);
  if (!options.json) {
    printStage(sortStage, output);
    printStage(expandStage, output);
  }

  result.screenshot!.bytes = screenshot.length;
  const screenshotStartedAt = now();
  let screenshotStage;
  try {
    filesystem.writeFileSync(screenshotPath, screenshot);
    result.screenshot!.saved = true;
    screenshotStage = {
      name: "screenshot",
      label: "screenshot",
      status: "ok",
      durationMs: now() - screenshotStartedAt,
      detail: `${Math.round(screenshot.length / 1024).toLocaleString("en-US")} KB → test-screenshot.png`,
    };
  } catch (error) {
    screenshotStage = {
      name: "screenshot",
      label: "screenshot not saved",
      status: "warn",
      durationMs: now() - screenshotStartedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  result.stages.push(screenshotStage);
  if (!options.json) printStage(screenshotStage, output);

  const extractionStartedAt = now();
  const extraction: FlightExtractionResult = await scraper.extractFlightsFromScreenshot(
    screenshot,
    route,
    env.ANTHROPIC_KEY,
  );
  result.rawText = extraction.rawText;
  result.filters!.extracted = extraction.flights.length;
  const extractionStage = {
    name: "extraction",
    label: "claude extraction",
    status: extraction.parseError ? "err" : "ok",
    durationMs: now() - extractionStartedAt,
    detail: `${extraction.flights.length} flight${extraction.flights.length === 1 ? "" : "s"}`,
  };
  result.stages.push(extractionStage);
  if (!options.json) printStage(extractionStage, output);

  if ((options.verbose || extraction.parseError) && !options.json) {
    output.log();
    output.log(ui.c.dim("Claude raw response"));
    for (const line of extraction.rawText.split("\n")) output.log(`${ui.c.dim("│")} ${line}`);
  }
  if (extraction.parseError) {
    throw Object.assign(new Error("Failed to parse Claude response as JSON."), { result });
  }

  const filters = {
    maxBudget: route.maxBudget ?? null,
    maxStops: route.maxStops ?? null,
    maxDurationHours: route.maxDurationHours ?? null,
  };
  const filterStartedAt = now();
  const filtered = scraper
    .filterFlights(extraction.flights, filters)
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  result.flights = filtered;
  result.filters!.passed = filtered.length;
  const filterStage = {
    name: "filters",
    label: "filters",
    status: filtered.length > 0 ? "ok" : "err",
    durationMs: now() - filterStartedAt,
    detail: `${filtered.length} pass  (${filterLabel(filters, route.currency ?? "USD")})`,
  };
  result.stages.push(filterStage);
  if (!options.json) printStage(filterStage, output);

  if (filtered.length === 0) {
    const cheapest =
      [...extraction.flights]
        .filter((flight): flight is Flight & { price: number } => Number.isFinite(flight.price))
        .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0] ?? null;
    result.cheapestSeen = cheapest;
    if (!options.json && cheapest) {
      output.log();
      renderFlights([cheapest], route.currency ?? "USD", output);
    }
    const detail = cheapest
      ? `Cheapest seen: ${ui.money(cheapest.price, route.currency ?? undefined)} (${cheapest.airline}, ${stopLabel(cheapest.stops)}, ${cheapest.duration})`
      : "Nothing was extracted from the page.";
    throw Object.assign(new Error(`No flights passed filters. ${detail}`), { result });
  }

  if (!options.json) {
    output.log();
    renderFlights(filtered, route.currency ?? "USD", output);
  }

  const best = filtered[0];
  const message = formatMessage(route, best);
  result.telegram!.preview = message;

  if (!options.json) {
    output.log();
    output.log(ui.c.dim("telegram preview"));
    for (const line of message.split("\n")) output.log(`${ui.c.dim("│")} ${line}`);
  }

  if (options.noSend) {
    const telegramStage = {
      name: "telegram",
      label: "telegram send skipped",
      status: "warn",
      durationMs: null,
    };
    result.stages.push(telegramStage);
    if (!options.json) printStage(telegramStage, output);
  } else {
    const telegramStartedAt = now();
    const response = await sender({
      token: env.TELEGRAM_KEY!,
      chatId: env.TELEGRAM_CHAT_ID!,
      message,
    });
    result.telegram!.chatId = env.TELEGRAM_CHAT_ID ?? null;
    result.telegram!.status = response.ok ? "sent" : "failed";
    const telegramStage = {
      name: "telegram",
      label: response.ok
        ? `sent to chat ${env.TELEGRAM_CHAT_ID}`
        : `telegram error ${response.status}`,
      status: response.ok ? "ok" : "err",
      durationMs: now() - telegramStartedAt,
    };
    result.stages.push(telegramStage);
    if (!options.json) printStage(telegramStage, output);
    if (!response.ok) {
      const body = await response.text();
      throw Object.assign(new Error(`Telegram error ${response.status}: ${body}`), { result });
    }
  }

  result.ok = true;
  result.durationMs = now() - startedAt;
  return result;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  output: Output = console,
): Promise<void> {
  let options: SmokeOptions | undefined;
  const wantsJson = argv.includes("--json");
  try {
    options = parseArgs(argv);
    const result = await runSmokeTest(options, { output });
    if (options.json) {
      output.log(JSON.stringify(result));
    } else {
      const checks = result.stages.filter((stage) => stage.status === "ok").length;
      const warnings = result.stages.filter((stage) => stage.status === "warn").length;
      output.log();
      output.log(
        `${ui.c.ok("PASS")}  ${checks} checks ${ui.glyph.dot} ${warnings} warning${warnings === 1 ? "" : "s"} ${ui.glyph.dot} ${ui.dur(result.durationMs)}`,
      );
    }
  } catch (error) {
    const errorWithResult = error as Error & { result?: SmokeResult };
    const result: SmokeResult = errorWithResult.result ?? {
      ok: false,
      route: null,
      stages: [],
      flights: [],
      filters: null,
      telegram: null,
      screenshot: null,
      rawText: "",
      error: null,
      durationMs: 0,
    };
    result.ok = false;
    result.error = errorWithResult.message;
    if (result.durationMs === 0 && result.stages.length > 0) {
      result.durationMs = result.stages.reduce((sum, stage) => sum + (stage.durationMs ?? 0), 0);
    }

    if (options?.json || wantsJson) output.log(JSON.stringify(result));
    else {
      output.error();
      output.error(`${ui.c.err("FAIL")}  ${errorWithResult.message}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
