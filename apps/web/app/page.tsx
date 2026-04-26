import fs from "node:fs";
import path from "node:path";
import {
  migrateJsonToYamlIfNeeded,
  readFlightbotConfig,
  readLastRunMarker,
  stripInternalConfigFields,
} from "@flightbot/shared";
import { RunPoller } from "./components/RunPoller";

export const dynamic = "force-dynamic";

function dataDir() {
  const d = process.env.FLIGHTBOT_DATA_DIR;
  if (!d) throw new Error("FLIGHTBOT_DATA_DIR is not set");
  return d;
}

function tailLog(dir: string, maxBytes = 24_000, maxLines = 12) {
  const logPath = path.join(dir, "results.log");
  if (!fs.existsSync(logPath)) return "(no results.log)";
  const stat = fs.statSync(logPath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(logPath, "r");
  try {
    const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
    fs.readSync(fd, buf, 0, buf.length, start);
    const raw = buf.toString("utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n") || "(empty)";
  } finally {
    fs.closeSync(fd);
  }
}

export default function HomePage() {
  const dir = dataDir();
  migrateJsonToYamlIfNeeded(dir);
  const { config, revision } = readFlightbotConfig(dir);
  const publicCfg = stripInternalConfigFields(config) as Record<string, unknown>;
  const routes = publicCfg.routes;
  const routeCount = Array.isArray(routes) ? routes.length : 0;
  const masked = {
    ...publicCfg,
    anthropic: { ...(publicCfg.anthropic as object), apiKey: "••••••" },
    telegram: { ...(publicCfg.telegram as object), token: "••••••" },
  };
  const lastRun = readLastRunMarker(dir);

  return (
    <>
      <RunPoller />
      <h1>Flightbot (Next.js)</h1>
      <p>
        Data dir: <code>{dir}</code> — config revision <strong>{revision}</strong>,{" "}
        <strong>{routeCount}</strong> route(s).
      </p>
      <section>
        <h2>Schedule</h2>
        <pre>{String((config as Record<string, unknown>).schedule ?? "")}</pre>
      </section>
      <section>
        <h2>Config (masked)</h2>
        <pre>{JSON.stringify(masked, null, 2)}</pre>
      </section>
      <section>
        <h2>Last bot run</h2>
        <pre>{JSON.stringify(lastRun, null, 2) ?? "null"}</pre>
      </section>
      <section>
        <h2>Log tail</h2>
        <pre>{tailLog(dir)}</pre>
      </section>
    </>
  );
}
