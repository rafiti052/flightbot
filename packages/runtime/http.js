import cron from "node-cron";
import {
  ConfigRevisionConflict,
  readFlightbotConfig,
  stripInternalConfigFields,
} from "@flightbot/shared";
import { deepMergePreservingSensitive, maskConfig } from "./api.js";

export function registerApiRoutes({
  app,
  dataDir,
  requireAdminAuth,
  configWriteRateLimit,
  loadConfig,
  buildStatusReadModel,
  writeConfigAtomic,
  applyCronSchedule,
  log,
}) {
  app.get("/", (req, res) => {
    res.json({
      ok: true,
      service: "flightbot-api",
      message: "Use the Next.js dashboard for configuration.",
      dashboard: process.env.FLIGHTBOT_WEB_URL || "http://localhost:3001",
    });
  });

  app.get("/config", requireAdminAuth, (req, res) => {
    try {
      const { config, revision } = readFlightbotConfig(dataDir);
      const publicShape = stripInternalConfigFields(config);
      res.json({ ...maskConfig(publicShape), revision });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/status", requireAdminAuth, (req, res) => {
    try {
      res.json(buildStatusReadModel());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/config", requireAdminAuth, configWriteRateLimit, (req, res) => {
    const ip = req.ip || "unknown";
    let auditResult = "invalid";
    let auditRevision = null;
    res.on("finish", () => {
      log(`[audit] PUT /config ip=${ip} result=${auditResult} revision=${auditRevision}`);
    });

    const incoming = req.body;
    const { expectedRevision: clientRevision, ...patch } = incoming;
    const expectedRevisionOpt =
      clientRevision !== undefined &&
      clientRevision !== null &&
      Number.isFinite(Number(clientRevision))
        ? Number(clientRevision)
        : undefined;

    if (patch.schedule !== undefined && !cron.validate(patch.schedule)) {
      auditResult = "invalid";
      return res.status(400).json({ error: `Invalid cron expression: "${patch.schedule}"` });
    }

    if (patch.routes) {
      for (const r of patch.routes) {
        if (!r.name || !r.from || !r.to || !r.departureDate) {
          auditResult = "invalid";
          return res.status(400).json({ error: "Route missing required field (name, from, to, departureDate)" });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.departureDate)) {
          auditResult = "invalid";
          return res.status(400).json({ error: `Route "${r.name}": departureDate must be YYYY-MM-DD` });
        }
        if (r.flexDays !== undefined && r.flexDays !== null) {
          if (!Number.isInteger(r.flexDays) || r.flexDays < 0 || r.flexDays > 7) {
            auditResult = "invalid";
            return res.status(400).json({ error: `Route "${r.name}": flexDays must be integer 0–7` });
          }
        }
      }
    }

    try {
      const onDisk = loadConfig();
      const merged = deepMergePreservingSensitive(patch, onDisk);
      writeConfigAtomic(merged, { expectedRevision: expectedRevisionOpt });
      let scheduled = "live";
      if (patch.schedule !== undefined && patch.schedule !== onDisk.schedule) {
        const ok = applyCronSchedule(merged.schedule, "from HTTP config save");
        scheduled = ok ? "live" : "restart-required";
      }
      const { revision } = readFlightbotConfig(dataDir);
      auditResult = "ok";
      auditRevision = revision;
      res.json({ ok: true, scheduled, revision });
    } catch (e) {
      if (e instanceof ConfigRevisionConflict) {
        auditResult = "conflict";
        auditRevision = e.actualRevision;
        return res.status(409).json({ error: e.message, revision: e.actualRevision });
      }
      auditResult = "invalid";
      res.status(500).json({ error: e.message });
    }
  });
}
