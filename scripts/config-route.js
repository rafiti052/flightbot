/**
 * Deterministic route management for config.json / prices.json.
 * Backs the /add-route and /reset-route commands so the agent parses intent,
 * then delegates the actual mutation here.
 *
 *   node scripts/config-route.js list
 *   node scripts/config-route.js add --from GRU --to JFK --depart 2026-09-10 \
 *        [--return 2026-09-20] [--budget 4000] [--stops 1] [--duration 14] \
 *        [--flex 2] [--currency BRL] [--name "GRU → JFK"]
 *   node scripts/config-route.js pause  "GRU → FLN"
 *   node scripts/config-route.js resume "GRU → FLN"
 *   node scripts/config-route.js reset  "GRU → FLN"    # clears price history
 *
 * Exits non-zero on any error so callers can detect failure without parsing prose.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const PRICES_PATH = path.join(ROOT, "prices.json");

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function readJson(p, fallback) {
  if (!fs.existsSync(p)) {
    if (fallback !== undefined) return fallback;
    die(`${p} not found`);
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    die(`${path.basename(p)} is malformed JSON: ${e.message}`);
  }
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

function findRoute(config, name) {
  const route = config.routes.find((r) => r.name === name);
  if (!route) {
    const available = config.routes.map((r) => `"${r.name}"`).join(", ") || "(none)";
    die(`No route named "${name}". Available: ${available}`);
  }
  return route;
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) die(`Expected a --flag, got "${argv[i]}"`);
    const key = argv[i].slice(2);
    const value = argv[i + 1];
    if (value === undefined) die(`Flag --${key} is missing a value`);
    flags[key] = value;
  }
  return flags;
}

function num(value, label) {
  if (value === undefined) return null;
  const n = Number(value);
  if (Number.isNaN(n)) die(`--${label} must be a number, got "${value}"`);
  return n;
}

const [command, ...rest] = process.argv.slice(2);
const config = readJson(CONFIG_PATH);
if (!Array.isArray(config.routes)) die("config.json has no routes array");

switch (command) {
  case "list": {
    const prices = readJson(PRICES_PATH, {});
    const rows = config.routes.map((r) => ({
      name: r.name,
      active: r.active !== false,
      maxBudget: r.maxBudget ?? null,
      depart: r.departureDate,
      return: r.returnDate ?? null,
      lastSeenPrice: prices[r.name]?.lastSeenPrice ?? null,
      lastAlertPrice: prices[r.name]?.lastAlertPrice ?? null,
    }));
    console.log(JSON.stringify(rows, null, 2));
    break;
  }

  case "add": {
    const f = parseFlags(rest);
    for (const required of ["from", "to", "depart"]) {
      if (!f[required]) die(`--${required} is required`);
    }
    const from = f.from.toUpperCase();
    const to = f.to.toUpperCase();
    const name = f.name ?? `${from} → ${to}`;

    if (config.routes.some((r) => r.name === name)) {
      die(`A route named "${name}" already exists. Use a different --name or remove it first.`);
    }
    for (const [flag, value] of [["depart", f.depart], ["return", f.return]]) {
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) die(`--${flag} must be YYYY-MM-DD, got "${value}"`);
    }

    const route = {
      name,
      from,
      to,
      roundTrip: Boolean(f.return),
      departureDate: f.depart,
      returnDate: f.return ?? null,
      flexDays: num(f.flex, "flex") ?? 0,
      currency: f.currency ?? "BRL",
      maxStops: num(f.stops, "stops"),
      maxBudget: num(f.budget, "budget"),
      maxDurationHours: num(f.duration, "duration"),
      active: true,
    };

    config.routes.push(route);
    writeJson(CONFIG_PATH, config);
    console.log(JSON.stringify({ added: route, totalRoutes: config.routes.length }, null, 2));
    break;
  }

  case "pause":
  case "resume": {
    const name = rest[0];
    if (!name) die(`usage: config-route.js ${command} "Route Name"`);
    const route = findRoute(config, name);
    route.active = command === "resume";
    writeJson(CONFIG_PATH, config);
    console.log(JSON.stringify({ route: route.name, active: route.active }, null, 2));
    break;
  }

  case "reset": {
    const name = rest[0];
    if (!name) die('usage: config-route.js reset "Route Name"');
    findRoute(config, name); // validate it exists before touching prices
    const prices = readJson(PRICES_PATH, {});
    if (!(name in prices)) {
      console.log(JSON.stringify({ route: name, cleared: false, reason: "no price history" }, null, 2));
      break;
    }
    const previous = prices[name];
    delete prices[name];
    writeJson(PRICES_PATH, prices);
    console.log(JSON.stringify({ route: name, cleared: true, previous }, null, 2));
    break;
  }

  default:
    die(`unknown command "${command ?? ""}". Use: list | add | pause | resume | reset`);
}
