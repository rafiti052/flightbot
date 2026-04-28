import fs from "fs";
import path from "path";

function formatLogArchiveTimestamp(date = new Date()) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * Worker-owned results log with rotation and retention.
 * @param {{ dataDir: string, maxBytes: number, retainFiles: number, onError?: (msg: string) => void }} options
 */
export function createResultsLogger(options) {
  const dataDir = options.dataDir;
  const logPath = path.join(dataDir, "results.log");
  const maxBytes = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : 20 * 1024 * 1024;
  const retainFiles = Number.isFinite(options.retainFiles) ? Number(options.retainFiles) : 7;
  const onError =
    typeof options.onError === "function"
      ? options.onError
      : (msg) => {
          try {
            console.error(msg);
          } catch {
            // ignore secondary failures
          }
        };

  function readAllLines() {
    if (!fs.existsSync(logPath)) return [];
    try {
      const raw = fs.readFileSync(logPath, "utf-8");
      return raw.split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  }

  function readRecentLines(maxLines = 400) {
    const lines = readAllLines();
    if (lines.length <= maxLines) return lines;
    return lines.slice(-maxLines);
  }

  function cleanupRotatedLogs() {
    try {
      const entries = fs
        .readdirSync(dataDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^results-\d{8}-\d{6}\.log$/.test(entry.name))
        .map((entry) => {
          const fullPath = path.join(dataDir, entry.name);
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(fullPath).mtimeMs;
          } catch {
            // keep at zero
          }
          return { name: entry.name, fullPath, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

      const toDelete = entries.slice(Math.max(0, retainFiles));
      for (const file of toDelete) {
        try {
          fs.unlinkSync(file.fullPath);
        } catch (e) {
          onError(`[flightbot] Failed to remove old log archive ${file.name}: ${e.message}`);
        }
      }
    } catch (e) {
      onError(`[flightbot] Failed to cleanup log archives: ${e.message}`);
    }
  }

  function rotateIfNeeded() {
    try {
      const stats = fs.statSync(logPath);
      if (!stats.isFile() || stats.size <= maxBytes) return;
      const archivePath = path.join(dataDir, `results-${formatLogArchiveTimestamp()}.log`);
      fs.renameSync(logPath, archivePath);
      cleanupRotatedLogs();
    } catch (e) {
      if (e?.code === "ENOENT") return;
      onError(`[flightbot] Failed rotating ${logPath}: ${e.message}`);
    }
  }

  function appendLine(line) {
    rotateIfNeeded();
    fs.appendFileSync(logPath, line + "\n");
  }

  function appendJson(record) {
    appendLine(JSON.stringify(record));
  }

  return {
    path: logPath,
    appendLine,
    appendJson,
    readAllLines,
    readRecentLines,
    rotateIfNeeded,
  };
}
