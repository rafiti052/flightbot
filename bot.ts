import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUrl,
  captureFlightsScreenshot,
  extractFlightsFromScreenshot,
  filterFlights,
} from "./scraper.ts";
import * as ui from "./ui.ts";
import type { AlertType, Flight, PricesFile, Route, RunOutcome, RuntimeConfig } from "./types.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const RUN_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const cron = createRequire(import.meta.url)("node-cron") as {
  schedule: (expression: string, callback: () => void) => unknown;
};

type Logger = (message: string) => void;
type Scraper = (route: Route, apiKey: string, log: Logger) => Promise<Flight[]>;
type Sender = (token: string, chatId: string, message: string) => Promise<boolean>;
type Clock = () => number;
type Sleeper = (ms: number) => Promise<void>;

export interface BotOptions {
  configPath?: string;
  envPath?: string;
  pricesPath?: string;
  logPath?: string;
  env?: NodeJS.ProcessEnv;
  loadEnvFile?: (path: string) => void;
  now?: Clock;
  sleep?: Sleeper;
  random?: () => number;
  scrape?: Scraper;
  send?: Sender;
  log?: Logger;
  appendFile?: (path: string, content: string) => void;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  exists?: (path: string) => boolean;
  schedule?: (expression: string, callback: () => void) => unknown;
}

const defaults = {
  configPath: path.join(root, "config.json"),
  envPath: path.join(root, ".env"),
  pricesPath: path.join(root, "prices.json"),
  logPath: path.join(root, "results.log"),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function formatError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}
function firstErrorLine(error: unknown): string {
  return errorMessage(error).split("\n", 1)[0];
}

export function loadConfig(options: BotOptions = {}): RuntimeConfig {
  const configPath = options.configPath ?? defaults.configPath;
  const exists = options.exists ?? fs.existsSync;
  const readFile = options.readFile ?? ((target) => fs.readFileSync(target, "utf8"));
  if (!exists(configPath))
    throw new Error(
      `config.json not found at ${configPath}. Please create it before running the bot.`,
    );
  let raw: string;
  try {
    raw = readFile(configPath);
  } catch (error) {
    throw new Error(`Failed to read config.json: ${errorMessage(error)}`, { cause: error });
  }
  let config: {
    schedule: string;
    routes: Route[];
    anthropic?: { apiKey?: string };
    telegram?: { token?: string; chatId?: string };
  };
  try {
    config = JSON.parse(raw) as typeof config;
  } catch (error) {
    throw new Error(`config.json is malformed JSON: ${errorMessage(error)}`, { cause: error });
  }
  const env = options.env ?? process.env;
  if (!env.ANTHROPIC_KEY) throw new Error("ANTHROPIC_KEY is not set (check .env)");
  if (!env.TELEGRAM_KEY) throw new Error("TELEGRAM_KEY is not set (check .env)");
  if (!env.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_CHAT_ID is not set (check .env)");
  return {
    ...config,
    anthropic: { ...config.anthropic, apiKey: env.ANTHROPIC_KEY },
    telegram: { ...config.telegram, token: env.TELEGRAM_KEY, chatId: env.TELEGRAM_CHAT_ID },
  };
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function dateVariants(route: Route): Route[] {
  const flex = route.flexDays ?? 0;
  if (flex === 0) return [route];
  return Array.from({ length: flex * 2 + 1 }, (_, index) => {
    const departureDate = shiftDate(route.departureDate, index - flex);
    return {
      ...route,
      departureDate,
      ...(route.returnDate ? { returnDate: shiftDate(route.returnDate, index - flex) } : {}),
      _dateLabel: `dep ${departureDate}`,
    };
  });
}

export function evaluateAlert(
  route: Route,
  best: Flight,
  state: PricesFile[string] | null | undefined,
): AlertType | null {
  const maxBudget = route.maxBudget ?? null;
  const price = best.price;
  if (price === null) return null;
  if (maxBudget === null)
    return state?.lastSeenPrice === undefined || price < state.lastSeenPrice ? "first" : null;
  if (price > maxBudget) return null;
  const last = state?.lastAlertPrice;
  if (last === undefined) return "first";
  if (price < last) return "lower";
  if (price === last) return null;
  return "returned";
}

async function scrapeFlights(route: Route, apiKey: string, log: Logger): Promise<Flight[]> {
  const screenshot = await captureFlightsScreenshot(route, { log });
  log("Screenshot captured, sending to Claude...");
  const { flights, rawText, parseError } = await extractFlightsFromScreenshot(
    screenshot,
    route,
    apiKey,
  );
  if (parseError) log(`Claude extraction failed to parse JSON. Raw: ${rawText.slice(0, 300)}`);
  log(`Claude extracted ${flights.length} flight(s)`);
  return filterFlights(flights, {
    maxStops: route.maxStops ?? null,
    maxDurationHours: route.maxDurationHours ?? null,
  })
    .sort((left, right) => (left.price ?? Infinity) - (right.price ?? Infinity))
    .slice(0, 5);
}

async function sendTelegram(
  token: string,
  chatId: string,
  message: string,
  log: Logger,
): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (response.ok) return true;
    log(`Telegram error ${response.status}: ${await response.text()}`);
  } catch (error) {
    log(`Telegram send failed: ${errorMessage(error)}`);
  }
  return false;
}

function formatDateLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
function formatMessage(route: Route, flight: Flight, alertType: AlertType): string {
  const emoji: Record<AlertType, string> = { first: "🟢", lower: "📉", returned: "🔁" };
  const stops =
    flight.stops === 0 ? "Nonstop" : `${flight.stops} stop${(flight.stops ?? 0) > 1 ? "s" : ""}`;
  const dates =
    route.roundTrip && route.returnDate
      ? `${formatDateLabel(route.departureDate)} → ${formatDateLabel(route.returnDate)}`
      : formatDateLabel(route.departureDate);
  const time =
    flight.depTime && flight.arrTime
      ? `${flight.depTime} → ${flight.arrTime}  (${flight.duration})`
      : (flight.duration ?? "N/A");
  return `${emoji[alertType]} Good price found — ${route.name}\n\n✈️  ${flight.airline ?? "Unknown airline"}  ·  ${stops}\n📅  ${dates}\n🕐  ${time}\n💰  ${route.currency ?? "USD"} ${(flight.price ?? 0).toLocaleString("pt-BR")}\n\n🔗 [Search on Google Flights](${buildUrl(route)})`;
}

function runtime(options: BotOptions) {
  const now = options.now ?? Date.now;
  const logPath = options.logPath ?? defaults.logPath;
  const append = options.appendFile ?? ((target, content) => fs.appendFileSync(target, content));
  const baseLog: Logger =
    options.log ??
    ((message) => {
      const line = `[${new Date(now()).toISOString()}] ${message}`;
      if (!ui.isTty) {
        try {
          console.log(line);
        } catch {
          /* console is best effort */
        }
      }
      try {
        append(logPath, `${line}\n`);
      } catch (error) {
        try {
          console.error(`[flightbot] Failed to append to ${logPath}: ${errorMessage(error)}`);
        } catch {
          /* secondary logging is best effort */
        }
      }
    });
  const loadPrices = (): PricesFile => {
    try {
      return (options.exists ?? fs.existsSync)(options.pricesPath ?? defaults.pricesPath)
        ? (JSON.parse(
            (options.readFile ?? ((target) => fs.readFileSync(target, "utf8")))(
              options.pricesPath ?? defaults.pricesPath,
            ),
          ) as PricesFile)
        : {};
    } catch {
      return {};
    }
  };
  const savePrices = (prices: PricesFile): void =>
    (options.writeFile ?? ((target, content) => fs.writeFileSync(target, content)))(
      options.pricesPath ?? defaults.pricesPath,
      JSON.stringify(prices, null, 2),
    );
  const alertRecord = (route: Route, flight: Flight, alertType: AlertType): void => {
    try {
      append(
        logPath,
        `${JSON.stringify({ ts: new Date(now()).toISOString(), route: route.name, alertType, price: flight.price, airline: flight.airline, stops: flight.stops, duration: flight.duration })}\n`,
      );
    } catch (error) {
      baseLog(`Failed to append alert record: ${errorMessage(error)}`);
    }
  };
  return { now, baseLog, loadPrices, savePrices, alertRecord };
}

export async function run(config: RuntimeConfig, options: BotOptions = {}): Promise<RunOutcome[]> {
  const deps = runtime(options);
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const scrape = options.scrape ?? ((route, key, log) => scrapeFlights(route, key, log));
  const send =
    options.send ?? ((token, chat, message) => sendTelegram(token, chat, message, deps.baseLog));
  const prices = deps.loadPrices();
  const outcomes: RunOutcome[] = [];
  deps.baseLog("=== Bot run started ===");
  for (const route of config.routes) {
    if (!route.active) {
      deps.baseLog(`[${route.name}] Skipped (inactive)`);
      continue;
    }
    deps.baseLog(`[${route.name}] Checking...`);
    const results: Flight[] = [];
    let routeError: unknown | null = null;
    for (const variant of dateVariants(route)) {
      const label = variant._dateLabel ? ` (${variant._dateLabel})` : "";
      deps.baseLog(`[${route.name}]${label} Scraping...`);
      try {
        const flights = await scrape(variant, config.anthropic.apiKey, (message) =>
          deps.baseLog(`[${route.name}] ${message}`),
        );
        flights.forEach((flight) => {
          flight._variant = variant;
        });
        results.push(...flights);
        deps.baseLog(`[${route.name}]${label} Found ${flights.length} result(s)`);
      } catch (error) {
        routeError ??= error;
        deps.baseLog(`[${route.name}]${label} Scrape error: ${errorMessage(error)}`);
      }
      await sleep(3000 + random() * 3000);
    }
    if (results.length === 0) {
      const error = routeError ?? new Error("No results across all date variants");
      deps.baseLog(`[${route.name}] No results across all date variants, skipping`);
      outcomes.push({
        route,
        best: null,
        budget: route.maxBudget ?? null,
        alertType: null,
        prevPrice: prices[route.name]?.lastSeenPrice ?? null,
        error,
      });
      continue;
    }
    results.sort((left, right) => (left.price ?? Infinity) - (right.price ?? Infinity));
    const best = results[0];
    if (best.price === null) continue;
    deps.baseLog(`[${route.name}] Best price: ${best.price}`);
    const state = prices[route.name];
    const prevPrice = state?.lastSeenPrice ?? null;
    const alertType = evaluateAlert(route, best, state);
    const timestamp = new Date(deps.now()).toISOString();
    if (alertType) {
      deps.baseLog(`[${route.name}] Alert type: ${alertType}, price: ${best.price}`);
      prices[route.name] = {
        ...state,
        lastAlertPrice: best.price,
        lastAlertAt: timestamp,
        lastSeenPrice: best.price,
        lastSeenAt: timestamp,
      };
      deps.savePrices(prices);
      deps.alertRecord(route, best, alertType);
      if (
        await send(
          config.telegram.token,
          config.telegram.chatId,
          formatMessage(best._variant ?? route, best, alertType),
        )
      )
        deps.baseLog("Telegram alert sent successfully");
    } else {
      deps.baseLog(
        `[${route.name}] No alert (price: ${best.price}, lastAlertPrice: ${state?.lastAlertPrice ?? "none"})`,
      );
      prices[route.name] = { ...state, lastSeenPrice: best.price, lastSeenAt: timestamp };
      deps.savePrices(prices);
    }
    outcomes.push({
      route,
      best: best.price,
      budget: route.maxBudget ?? null,
      alertType,
      prevPrice,
      error: routeError,
    });
    if (route !== config.routes.filter((item) => item.active).at(-1)) await sleep(5000);
  }
  deps.baseLog("=== Bot run complete ===");
  return outcomes;
}

let runState = { inProgress: false, startedAt: 0 };
export async function runWithLock(
  config: RuntimeConfig,
  trigger: "startup" | "schedule",
  options: BotOptions = {},
): Promise<void> {
  const now = (options.now ?? Date.now)();
  const log = runtime(options).baseLog;
  if (runState.inProgress && now - runState.startedAt < RUN_LOCK_STALE_MS) {
    log(
      `Skipping ${trigger} run because another run is still active (${Math.round((now - runState.startedAt) / 1000)}s old)`,
    );
    return;
  }
  if (runState.inProgress)
    log(
      `Previous run lock was stale after ${Math.round((now - runState.startedAt) / 1000)}s; forcing a new ${trigger} run`,
    );
  runState = { inProgress: true, startedAt: now };
  try {
    await run(config, options);
  } catch (error) {
    log(`${trigger === "startup" ? "Initial" : "Scheduled"} run failed: ${formatError(error)}`);
  } finally {
    runState = { inProgress: false, startedAt: 0 };
  }
}

export function main(options: BotOptions = {}): void {
  try {
    (options.loadEnvFile ?? process.loadEnvFile)(options.envPath ?? defaults.envPath);
  } catch {
    /* environment injection is supported */
  }
  let config: RuntimeConfig;
  try {
    config = loadConfig(options);
  } catch (error) {
    console.error(ui.status("err", `config error: ${firstErrorLine(error)} — check .env`));
    process.exitCode = 1;
    return;
  }
  runtime(options).baseLog(`Bot started. Schedule: ${config.schedule}`);
  (options.schedule ?? cron.schedule)(config.schedule, () => {
    void runWithLock(loadConfig(options), "schedule", options);
  });
  process.on("unhandledRejection", (reason) =>
    runtime(options).baseLog(`Unhandled rejection: ${formatError(reason)}`),
  );
  process.on("uncaughtException", (error) =>
    runtime(options).baseLog(`Uncaught exception: ${formatError(error)}`),
  );
  void runWithLock(config, "startup", options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
