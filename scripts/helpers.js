import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { migrateJsonToYamlIfNeeded, readFlightbotConfig, resolveFlightbotDataDir } from "@flightbot/shared";

export function resolveDataDir() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { dataDir } = resolveFlightbotDataDir({
    envValue: process.env.FLIGHTBOT_DATA_DIR,
    fallbackDir: repoRoot,
    relativeTo: repoRoot,
    onFallback: (fallbackDir) => {
      console.warn(`[flightbot] FLIGHTBOT_DATA_DIR is not set; using the repo root for local scripts: ${fallbackDir}`);
    },
  });
  return dataDir;
}

export function loadConfig() {
  const dataDir = resolveDataDir();
  const migration = migrateJsonToYamlIfNeeded(dataDir);
  if (migration.migrated && migration.message) {
    console.log(`[flightbot] ${migration.message}`);
  }
  const { config } = readFlightbotConfig(dataDir);
  return { config, dataDir };
}

export function resolveOutputPath(filename) {
  return path.resolve(process.cwd(), filename);
}

export function writeOutputFile(filePath, content) {
  fs.writeFileSync(filePath, content);
}
