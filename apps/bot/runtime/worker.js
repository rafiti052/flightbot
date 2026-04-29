import fs from "fs";
import path from "path";

export function createPriceStore(dataDir) {
  const pricesPath = path.join(dataDir, "prices.json");

  function loadPrices() {
    if (!fs.existsSync(pricesPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(pricesPath, "utf-8"));
    } catch {
      return {};
    }
  }

  function savePrices(prices) {
    fs.writeFileSync(pricesPath, JSON.stringify(prices, null, 2));
  }

  return { loadPrices, savePrices };
}

export function createRuntimeLogger(resultsLog) {
  function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    try {
      console.log(line);
    } catch {
      // Ignore console failures so we can still attempt file logging.
    }
    try {
      resultsLog.appendLine(line);
    } catch (e) {
      try {
        console.error(`[flightbot] Failed to append to ${resultsLog.path}: ${e.message}`);
      } catch {
        // Ignore secondary logging failures.
      }
    }
  }

  function logAlert(route, flight, alertType) {
    const record = {
      ts: new Date().toISOString(),
      route: route.name,
      alertType,
      price: flight.price,
      airline: flight.airline,
      stops: flight.stops,
      duration: flight.duration,
    };
    try {
      resultsLog.appendJson(record);
    } catch (e) {
      log(`Failed to append alert record: ${e.message}`);
    }
  }

  return { log, logAlert };
}
