import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";

const CONFIG_YML = "config.yml";
const CONFIG_JSON = "config.json";

/** @param {string} dataDir */
export function getConfigYmlPath(dataDir) {
  return path.join(dataDir, CONFIG_YML);
}

/** @param {string} dataDir */
export function getConfigJsonPath(dataDir) {
  return path.join(dataDir, CONFIG_JSON);
}

/** @param {string} dataDir */
export function getLastRunDir(dataDir) {
  return path.join(dataDir, ".flightbot");
}

/** @param {string} dataDir */
export function getLastRunPath(dataDir) {
  return path.join(getLastRunDir(dataDir), "last-run.json");
}

/**
 * If config.yml is missing and config.json exists, write config.yml from JSON (one-time).
 * @param {string} dataDir
 * @returns {{ migrated: boolean, message?: string }}
 */
export function migrateJsonToYamlIfNeeded(dataDir) {
  const ymlPath = getConfigYmlPath(dataDir);
  if (fs.existsSync(ymlPath)) {
    return { migrated: false };
  }
  const jsonPath = getConfigJsonPath(dataDir);
  if (!fs.existsSync(jsonPath)) {
    return { migrated: false, message: "Neither config.yml nor config.json found" };
  }
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, "utf-8");
  } catch (e) {
    throw new Error(`Failed to read ${jsonPath}: ${e.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Legacy config.json is invalid JSON: ${e.message}`);
  }
  const now = new Date().toISOString();
  const out = {
    ...doc,
    schemaVersion: typeof doc.schemaVersion === "number" ? doc.schemaVersion : 1,
    _configMeta: {
      revision: 0,
      updatedAt: now,
    },
  };
  atomicWriteText(ymlPath, YAML.stringify(out, { lineWidth: 120 }));
  return { migrated: true, message: `Migrated ${jsonPath} → ${ymlPath}` };
}

/**
 * @param {string} filePath
 * @param {string} text
 */
function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, filePath);
}

/**
 * @param {object} doc
 * @returns {{ schedule: unknown, anthropic: unknown, telegram: unknown, routes: unknown[], schemaVersion?: number, _configMeta?: { revision: number, updatedAt: string } }}
 */
function normalizeDocument(doc) {
  if (!doc || typeof doc !== "object") {
    throw new Error("config.yml root must be a mapping");
  }
  const routes = Array.isArray(doc.routes) ? doc.routes : [];
  return {
    schemaVersion: typeof doc.schemaVersion === "number" ? doc.schemaVersion : 1,
    schedule: doc.schedule,
    anthropic: doc.anthropic ?? {},
    telegram: doc.telegram ?? {},
    routes,
    _configMeta:
      doc._configMeta && typeof doc._configMeta === "object"
        ? {
            revision: Number.isInteger(doc._configMeta.revision) ? doc._configMeta.revision : 0,
            updatedAt: typeof doc._configMeta.updatedAt === "string" ? doc._configMeta.updatedAt : new Date().toISOString(),
          }
        : { revision: 0, updatedAt: new Date().toISOString() },
  };
}

/**
 * Runtime config object (same shape as legacy JSON) plus internal meta for writes.
 * @param {string} dataDir
 * @returns {{ config: object, revision: number }}
 */
export function readFlightbotConfig(dataDir) {
  const ymlPath = getConfigYmlPath(dataDir);
  if (!fs.existsSync(ymlPath)) {
    throw new Error(`config.yml not found at ${ymlPath}. Create it or keep config.json for one-time migration.`);
  }
  const maxYamlBytes = 2 * 1024 * 1024;
  const st = fs.statSync(ymlPath);
  if (st.size > maxYamlBytes) {
    throw new Error(`config.yml is unexpectedly large (${st.size} bytes); refusing to read`);
  }
  let raw;
  try {
    raw = fs.readFileSync(ymlPath, "utf-8");
  } catch (e) {
    throw new Error(`Failed to read config.yml: ${e.message}`);
  }
  let doc;
  try {
    doc = YAML.parse(raw);
  } catch (e) {
    throw new Error(`config.yml is invalid YAML: ${e.message}`);
  }
  const normalized = normalizeDocument(doc);
  const revision = normalized._configMeta.revision;
  const config = {
    schemaVersion: normalized.schemaVersion,
    schedule: normalized.schedule,
    anthropic: normalized.anthropic,
    telegram: normalized.telegram,
    routes: normalized.routes,
    _configMeta: normalized._configMeta,
  };
  return { config, revision };
}

export class ConfigRevisionConflict extends Error {
  /** @param {number} expected @param {number} actual */
  constructor(expected, actual) {
    super(`config revision mismatch: expected ${expected}, on disk ${actual}`);
    this.name = "ConfigRevisionConflict";
    this.expectedRevision = expected;
    this.actualRevision = actual;
  }
}

/**
 * @param {string} dataDir
 * @param {object} config full merged config including anthropic/telegram secrets and _configMeta
 * @param {{ expectedRevision?: number | null }} [options]
 */
export function writeFlightbotConfigAtomic(dataDir, config, options = {}) {
  const { expectedRevision } = options;
  const ymlPath = getConfigYmlPath(dataDir);
  const { config: onDisk, revision: currentRev } = readFlightbotConfig(dataDir);
  if (expectedRevision != null && Number(expectedRevision) !== currentRev) {
    throw new ConfigRevisionConflict(Number(expectedRevision), currentRev);
  }
  const nextRev = currentRev + 1;
  const now = new Date().toISOString();
  const doc = {
    schemaVersion: config.schemaVersion ?? onDisk.schemaVersion ?? 1,
    schedule: config.schedule,
    anthropic: config.anthropic,
    telegram: config.telegram,
    routes: Array.isArray(config.routes) ? config.routes : [],
    _configMeta: {
      revision: nextRev,
      updatedAt: now,
    },
  };
  atomicWriteText(ymlPath, YAML.stringify(doc, { lineWidth: 120 }));
}

/** Strip fields the UI should not echo back as editable shape. */
export function stripInternalConfigFields(cfg) {
  if (!cfg || typeof cfg !== "object") return {};
  const { _configMeta, schemaVersion, ...rest } = cfg;
  void _configMeta;
  void schemaVersion;
  return rest;
}

/**
 * @param {string} dataDir
 * @param {{ status: 'ok' | 'error', error?: string | null }} payload
 */
export function writeLastRunMarker(dataDir, payload) {
  const dir = getLastRunDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = getLastRunPath(dataDir);
  const tmp = finalPath + ".tmp";
  const body = {
    finishedAt: new Date().toISOString(),
    status: payload.status,
    runId: randomUUID(),
  };
  if (payload.status === "error" && payload.error) {
    body.error = String(payload.error).slice(0, 2000);
  }
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), "utf-8");
  fs.renameSync(tmp, finalPath);
}

/** @param {string} dataDir */
export function readLastRunMarker(dataDir) {
  const p = getLastRunPath(dataDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
