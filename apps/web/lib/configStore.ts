import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const CONFIG_YML = "config.yml";
const CONFIG_JSON = "config.json";

function getConfigYmlPath(dataDir: string) {
  return path.join(dataDir, CONFIG_YML);
}

function getConfigJsonPath(dataDir: string) {
  return path.join(dataDir, CONFIG_JSON);
}

function getLastRunPath(dataDir: string) {
  return path.join(dataDir, ".flightbot", "last-run.json");
}

function atomicWriteText(filePath: string, text: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, filePath);
}

function normalizeDocument(doc: Record<string, unknown>) {
  if (!doc || typeof doc !== "object") {
    throw new Error("config.yml root must be a mapping");
  }
  const routes = Array.isArray(doc.routes) ? doc.routes : [];
  const meta = doc._configMeta;
  return {
    schemaVersion: typeof doc.schemaVersion === "number" ? doc.schemaVersion : 1,
    schedule: doc.schedule,
    anthropic: doc.anthropic ?? {},
    telegram: doc.telegram ?? {},
    routes,
    _configMeta:
      meta && typeof meta === "object"
        ? {
            revision:
              Number.isInteger((meta as { revision?: unknown }).revision) &&
              typeof (meta as { revision?: unknown }).revision === "number"
                ? ((meta as { revision: number }).revision as number)
                : 0,
            updatedAt:
              typeof (meta as { updatedAt?: unknown }).updatedAt === "string"
                ? ((meta as { updatedAt: string }).updatedAt as string)
                : new Date().toISOString(),
          }
        : { revision: 0, updatedAt: new Date().toISOString() },
  };
}

export function migrateJsonToYamlIfNeeded(dataDir: string) {
  const ymlPath = getConfigYmlPath(dataDir);
  if (fs.existsSync(ymlPath)) return { migrated: false };
  const jsonPath = getConfigJsonPath(dataDir);
  if (!fs.existsSync(jsonPath)) return { migrated: false, message: "Neither config.yml nor config.json found" };

  const raw = fs.readFileSync(jsonPath, "utf-8");
  const doc = JSON.parse(raw) as Record<string, unknown>;
  const now = new Date().toISOString();
  const out = {
    ...doc,
    schemaVersion: typeof doc.schemaVersion === "number" ? doc.schemaVersion : 1,
    _configMeta: { revision: 0, updatedAt: now },
  };
  atomicWriteText(ymlPath, YAML.stringify(out, { lineWidth: 120 }));
  return { migrated: true, message: `Migrated ${jsonPath} -> ${ymlPath}` };
}

export function readFlightbotConfig(dataDir: string) {
  const ymlPath = getConfigYmlPath(dataDir);
  if (!fs.existsSync(ymlPath)) throw new Error(`config.yml not found at ${ymlPath}.`);
  const raw = fs.readFileSync(ymlPath, "utf-8");
  const doc = YAML.parse(raw) as Record<string, unknown>;
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

export function stripInternalConfigFields(cfg: Record<string, unknown>) {
  const { _configMeta, schemaVersion, ...rest } = cfg;
  void _configMeta;
  void schemaVersion;
  return rest;
}

export function readLastRunMarker(dataDir: string) {
  const p = getLastRunPath(dataDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
