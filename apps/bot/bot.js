import cron from "node-cron";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFlightbotConfig,
  writeFlightbotConfigAtomic,
  writeLastRunMarker,
  createResultsLogger,
  resolveFlightbotDataDir,
} from "@flightbot/shared";
import {
  parseIntEnv,
  formatError,
  withTimeout,
  dateVariants,
  buildUrl,
  parseDurationHours,
  formatMessage,
  evaluateAlert,
  getVariantScrapeCount,
  summarizeRecentLogActivity,
  deriveRouteStateSummary,
  buildRecentActivity,
} from "./runtime/core.js";
import { createPriceStore, createRuntimeLogger } from "./runtime/worker.js";
import { requireAdminAuth, createConfigWriteRateLimit } from "./runtime/api.js";
import { registerApiRoutes } from "./runtime/http.js";
import { createWorkerOrchestrator } from "./runtime/orchestration.js";
import { createScrapingWorker } from "./runtime/scraping.js";
import { createNotifier } from "./runtime/notify.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { dataDir: DATA_DIR } = resolveFlightbotDataDir({
  envValue: process.env.FLIGHTBOT_DATA_DIR,
  fallbackDir: REPO_ROOT,
  relativeTo: REPO_ROOT,
  onFallback: (fallbackDir) => {
    console.warn(`[flightbot] FLIGHTBOT_DATA_DIR is not set; falling back to the repo root for local use: ${fallbackDir}`);
  },
});
const LOG_MAX_BYTES = parseIntEnv("FLIGHTBOT_LOG_MAX_BYTES", 20 * 1024 * 1024);
const LOG_RETAIN_FILES = parseIntEnv("FLIGHTBOT_LOG_RETAIN_FILES", 7);
const LOG_MAX_AGE_DAYS_RAW = parseIntEnv("FLIGHTBOT_LOG_MAX_AGE_DAYS", 0);
const LOG_MAX_AGE_DAYS = LOG_MAX_AGE_DAYS_RAW > 0 ? LOG_MAX_AGE_DAYS_RAW : null;
const resultsLog = createResultsLogger({
  dataDir: DATA_DIR,
  maxBytes: LOG_MAX_BYTES,
  retainFiles: LOG_RETAIN_FILES,
  maxAgeDays: LOG_MAX_AGE_DAYS,
  onError: (msg) => {
    try {
      console.error(msg);
    } catch {
      // ignore secondary failures
    }
  },
});
const { loadPrices, savePrices } = createPriceStore(DATA_DIR);
const { log, logAlert } = createRuntimeLogger(resultsLog);
const { sendRouteAlert } = createNotifier({ log, formatMessage });

function enforceStartupLogRetention() {
  if (typeof resultsLog.enforceRetention !== "function") return;

  try {
    resultsLog.enforceRetention();
  } catch (error) {
    log(`Startup log retention failed: ${formatError(error)}`);
  }
}

enforceStartupLogRetention();

const RUN_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function loadConfig() {
  const { config } = readFlightbotConfig(DATA_DIR);
  return config;
}

const { scrapeFlights } = createScrapingWorker({
  log,
  withTimeout,
  buildUrl,
  parseDurationHours,
});

function buildStatusReadModel() {
  const config = loadConfig();
  const prices = loadPrices();
  const runState = workerOrchestrator.getRunState();
  const summaryLogLines = resultsLog.readRecentLines(4000, { maxBytes: 4 * 1024 * 1024 });
  const recentLogLines = resultsLog.readRecentLines(400, { maxBytes: 512 * 1024 });
  const logSummary = summarizeRecentLogActivity(summaryLogLines);
  const recentActivity = buildRecentActivity(recentLogLines);
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const activeRoutes = routes.filter((route) => route.active);
  const routeSummaries = routes.map((route) => deriveRouteStateSummary(route, prices[route.name], logSummary));
  const activeVariantChecksPerRun = activeRoutes.reduce((sum, route) => sum + getVariantScrapeCount(route), 0);

  return {
    generatedAt: new Date().toISOString(),
    runtime: {
      inProgress: runState.inProgress,
      startedAt: runState.startedAt ? new Date(runState.startedAt).toISOString() : null,
      activeRunAgeMs: runState.inProgress ? Date.now() - runState.startedAt : 0,
      lockStaleAfterMs: RUN_LOCK_STALE_MS,
    },
    schedule: {
      expression: config.schedule ?? null,
      valid: typeof config.schedule === "string" ? cron.validate(config.schedule) : false,
      timezone: "America/Sao_Paulo",
      lastRunStartedAt: logSummary.lastRunStartedAt,
      lastRunCompletedAt: logSummary.lastRunCompletedAt,
      lastRunStatus: logSummary.lastRunStatus,
      lastFailureAt: logSummary.lastFailureAt,
      lastFailureMessage: logSummary.lastFailureMessage,
    },
    routes: {
      totalCount: routes.length,
      activeCount: activeRoutes.length,
      inactiveCount: routes.length - activeRoutes.length,
      activeVariantChecksPerRun,
    },
    recentActivity,
    routeSummaries,
  };
}

async function run(config) {
  log("=== Bot run started ===");
  const prices = loadPrices();

  const activeRoutes = config.routes.filter((r) => {
    if (!r.active) {
      log(`[${r.name}] Skipped (inactive)`);
      return false;
    }
    return true;
  });

  for (let i = 0; i < activeRoutes.length; i++) {
    const route = activeRoutes[i];
    log(`[${route.name}] Checking...`);

    const variants = dateVariants(route);
    const variantResults = [];

    for (const variant of variants) {
      const label = variant._dateLabel ? ` (${variant._dateLabel})` : "";
      log(`[${route.name}]${label} Scraping...`);
      try {
        const results = await scrapeFlights(variant, config.anthropic.apiKey);
        log(`[${route.name}]${label} Found ${results.length} result(s)`);
        for (const r of results) r._variant = variant;
        variantResults.push(results);
      } catch (e) {
        log(`[${route.name}]${label} Scrape error: ${e.message}`);
        variantResults.push([]);
      }

      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 3000));
    }

    const allResults = variantResults.flat();

    if (allResults.length === 0) {
      log(`[${route.name}] No results across all date variants, skipping`);
      continue;
    }

    allResults.sort((a, b) => a.price - b.price);
    const best = allResults[0];
    log(`[${route.name}] Best price: ${best.price}`);

    const state = prices[route.name] ?? null;
    const alertType = evaluateAlert(route, best, state);
    const now = new Date().toISOString();

    if (alertType !== null) {
      log(`[${route.name}] Alert type: ${alertType}, price: ${best.price}`);
      prices[route.name] = {
        ...(state ?? {}),
        lastAlertPrice: best.price,
        lastAlertAt: now,
        lastSeenPrice: best.price,
        lastSeenAt: now,
      };
      savePrices(prices);
      logAlert(route, best, alertType);

      await sendRouteAlert({
        route,
        best,
        alertType,
        telegram: config.telegram,
      });
    } else {
      log(`[${route.name}] No alert (price: ${best.price}, lastAlertPrice: ${state?.lastAlertPrice ?? "none"})`);
      prices[route.name] = {
        ...(state ?? {}),
        lastSeenPrice: best.price,
        lastSeenAt: now,
      };
      savePrices(prices);
    }

    if (i < activeRoutes.length - 1) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  log("=== Bot run complete ===");
}

const workerOrchestrator = createWorkerOrchestrator({
  run,
  loadConfig,
  log,
  formatError,
  writeLastRunMarker: (payload) => writeLastRunMarker(DATA_DIR, payload),
  lockStaleMs: RUN_LOCK_STALE_MS,
});
const { applyCronSchedule, runWithLock } = workerOrchestrator;

function writeConfigAtomic(config, options = {}) {
  writeFlightbotConfigAtomic(DATA_DIR, config, options);
}

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json({ limit: "128kb" }));

const configWriteRateLimit = createConfigWriteRateLimit();
registerApiRoutes({
  app,
  dataDir: DATA_DIR,
  requireAdminAuth,
  configWriteRateLimit,
  loadConfig,
  buildStatusReadModel,
  writeConfigAtomic,
  applyCronSchedule,
  log,
});

app.listen(PORT, () => {
  log(`UI server running on http://localhost:${PORT}`);
});

const config = loadConfig();

applyCronSchedule(config.schedule, "startup");

log(`Bot started. Schedule: ${config.schedule}`);
process.on("unhandledRejection", (reason) => {
  log(`Unhandled rejection: ${formatError(reason)}`);
});

process.on("uncaughtException", (error) => {
  log(`Uncaught exception: ${formatError(error)}`);
});

runWithLock(config, "startup");
