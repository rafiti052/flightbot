import cron from "node-cron";

export function createWorkerOrchestrator({
  run,
  loadConfig,
  log,
  formatError,
  writeLastRunMarker,
  lockStaleMs,
}) {
  let runState = {
    inProgress: false,
    startedAt: 0,
  };

  /** @type {ReturnType<typeof cron.schedule> | null} */
  let cronJob = null;

  function getRunState() {
    return runState;
  }

  /**
   * Re-register the cron job so schedule changes take effect without restarting the process.
   * @param {string | undefined} expression
   * @param {string} [label]
   * @returns {boolean}
   */
  function applyCronSchedule(expression, label = "schedule") {
    const expr = expression == null ? "" : String(expression);
    if (!cron.validate(expr)) {
      log(`Refusing invalid cron expression (${label}): ${expr}`);
      return false;
    }
    if (cronJob) {
      try {
        cronJob.stop();
      } catch (e) {
        log(`Failed to stop previous cron job: ${e.message}`);
      }
      cronJob = null;
    }
    cronJob = cron.schedule(expr, () => {
      const freshConfig = loadConfig();
      runWithLock(freshConfig, "schedule");
    });
    log(`Cron registered (${label}): ${expr}`);
    return true;
  }

  async function runWithLock(config, trigger) {
    const now = Date.now();
    if (runState.inProgress) {
      const ageMs = now - runState.startedAt;
      if (ageMs < lockStaleMs) {
        log(`Skipping ${trigger} run because another run is still active (${Math.round(ageMs / 1000)}s old)`);
        return;
      }
      log(`Previous run lock was stale after ${Math.round(ageMs / 1000)}s; forcing a new ${trigger} run`);
    }

    runState = { inProgress: true, startedAt: now };
    let runFailed = false;
    let runErrorText = null;
    try {
      await run(config);
    } catch (e) {
      runFailed = true;
      runErrorText = formatError(e);
      log(`${trigger === "startup" ? "Initial" : "Scheduled"} run failed: ${runErrorText}`);
    } finally {
      runState = { inProgress: false, startedAt: 0 };
      try {
        writeLastRunMarker({
          status: runFailed ? "error" : "ok",
          error: runFailed ? runErrorText : null,
        });
      } catch (e2) {
        log(`Failed to write last-run marker: ${e2.message}`);
      }
    }
  }

  return {
    getRunState,
    applyCronSchedule,
    runWithLock,
  };
}
