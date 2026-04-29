import fs from "fs";
import path from "path";
import { migrateJsonToYamlIfNeeded, readFlightbotConfig } from "@flightbot/shared";

export function resolveDataDir() {
  return process.env.FLIGHTBOT_DATA_DIR || process.cwd();
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
