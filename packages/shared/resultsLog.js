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

function countNewlines(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") count += 1;
  }
  return count;
}

/**
 * Worker-owned results log with rotation and retention.
 * @param {{ dataDir: string, maxBytes: number, retainFiles: number, maxAgeDays?: number | null, onError?: (msg: string) => void }} options
 */
export function createResultsLogger(options) {
  const dataDir = options.dataDir;
  const logPath = path.join(dataDir, "results.log");
  const maxBytes = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : 20 * 1024 * 1024;
  const retainFiles = Number.isFinite(options.retainFiles) ? Number(options.retainFiles) : 7;
  const maxAgeDays =
    Number.isFinite(options.maxAgeDays) && Number(options.maxAgeDays) > 0 ? Number(options.maxAgeDays) : null;
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

  function listArchiveEntries() {
    return fs
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
      });
  }

  function readAllLines() {
    if (!fs.existsSync(logPath)) return [];
    try {
      const raw = fs.readFileSync(logPath, "utf-8");
      return raw.split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  }

  function readRecentLines(maxLines = 400, options = {}) {
    if (!fs.existsSync(logPath)) return [];

    const targetLines = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : 400;
    const chunkSize =
      Number.isFinite(options.chunkSize) && options.chunkSize > 0 ? Math.floor(options.chunkSize) : 64 * 1024;
    const maxBytes =
      Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.floor(options.maxBytes) : 4 * 1024 * 1024;

    let fd;
    try {
      const stats = fs.statSync(logPath);
      if (!stats.isFile() || stats.size === 0) return [];

      fd = fs.openSync(logPath, "r");
      let position = stats.size;
      let bytesScanned = 0;
      let newlineCount = 0;
      let collected = "";

      while (position > 0 && bytesScanned < maxBytes && newlineCount <= targetLines) {
        const bytesToRead = Math.min(chunkSize, position, maxBytes - bytesScanned);
        position -= bytesToRead;
        const buffer = Buffer.allocUnsafe(bytesToRead);
        fs.readSync(fd, buffer, 0, bytesToRead, position);
        const chunk = buffer.toString("utf-8");
        collected = chunk + collected;
        bytesScanned += bytesToRead;
        newlineCount += countNewlines(chunk);
      }

      const lines = collected.split(/\r?\n/).filter(Boolean);
      if (lines.length <= targetLines) return lines;
      return lines.slice(-targetLines);
    } catch {
      return [];
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close failures
        }
      }
    }
  }

  function pruneArchives() {
    try {
      let entries = listArchiveEntries().sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

      if (maxAgeDays != null) {
        const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        const kept = [];
        for (const file of entries) {
          if (file.mtimeMs > 0 && file.mtimeMs < cutoffMs) {
            try {
              fs.unlinkSync(file.fullPath);
            } catch (e) {
              onError(`[flightbot] Failed to remove expired log archive ${file.name}: ${e.message}`);
              kept.push(file);
            }
            continue;
          }
          kept.push(file);
        }
        entries = kept;
      }

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
      pruneArchives();
    } catch (e) {
      if (e?.code === "ENOENT") return;
      onError(`[flightbot] Failed rotating ${logPath}: ${e.message}`);
    }
  }

  function enforceRetention() {
    rotateIfNeeded();
    pruneArchives();
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
    enforceRetention,
    pruneArchives,
    rotateIfNeeded,
  };
}
