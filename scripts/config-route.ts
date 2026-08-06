/** Deterministic route management for config.json / prices.json. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigFile, PricesFile, Route } from "../types.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(root, "config.json");
const defaultPricesPath = path.join(root, "prices.json");

type Output = (value: string) => void;
type Exit = (code: number) => void;

export type RouteManagerOptions = {
  argv: readonly string[];
  configPath?: string;
  pricesPath?: string;
  stdout?: Output;
  stderr?: Output;
  exit?: Exit;
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function runRouteManager({
  argv,
  configPath = defaultConfigPath,
  pricesPath = defaultPricesPath,
  stdout = (value) => process.stdout.write(value),
  stderr = (value) => process.stderr.write(value),
  exit = (code) => {
    process.exitCode = code;
  },
}: RouteManagerOptions): number {
  const fail = (message: string): number => {
    stderr(`error: ${message}\n`);
    exit(1);
    return 1;
  };
  const readJson = (filePath: string, fallback?: unknown): unknown => {
    if (!fs.existsSync(filePath)) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${filePath} not found`);
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`${path.basename(filePath)} is malformed JSON: ${(error as Error).message}`, {
        cause: error,
      });
    }
  };
  const writeJson = (filePath: string, data: unknown): void =>
    fs.writeFileSync(filePath, json(data));
  const parseFlags = (values: string[]): Record<string, string> => {
    const flags: Record<string, string> = {};
    for (let index = 0; index < values.length; index += 2) {
      if (!values[index].startsWith("--"))
        throw new Error(`Expected a --flag, got "${values[index]}"`);
      const key = values[index].slice(2);
      const value = values[index + 1];
      if (value === undefined) throw new Error(`Flag --${key} is missing a value`);
      flags[key] = value;
    }
    return flags;
  };
  const numberFlag = (value: string | undefined, label: string): number | null => {
    if (value === undefined) return null;
    const result = Number(value);
    if (Number.isNaN(result)) throw new Error(`--${label} must be a number, got "${value}"`);
    return result;
  };

  try {
    const [command, ...rest] = argv;
    const config = readJson(configPath) as ConfigFile;
    if (!Array.isArray(config.routes)) throw new Error("config.json has no routes array");
    const findRoute = (name: string): Route => {
      const route = config.routes.find((candidate) => candidate.name === name);
      if (route) return route;
      const available =
        config.routes.map((candidate) => `"${candidate.name}"`).join(", ") || "(none)";
      throw new Error(`No route named "${name}". Available: ${available}`);
    };

    switch (command) {
      case "list": {
        const prices = readJson(pricesPath, {}) as PricesFile;
        stdout(
          json(
            config.routes.map((route) => ({
              name: route.name,
              active: route.active !== false,
              maxBudget: route.maxBudget ?? null,
              depart: route.departureDate,
              return: route.returnDate ?? null,
              lastSeenPrice: prices[route.name]?.lastSeenPrice ?? null,
              lastAlertPrice: prices[route.name]?.lastAlertPrice ?? null,
            })),
          ),
        );
        return 0;
      }
      case "add": {
        const flags = parseFlags(rest);
        for (const required of ["from", "to", "depart"]) {
          if (!flags[required]) throw new Error(`--${required} is required`);
        }
        const from = flags.from.toUpperCase();
        const to = flags.to.toUpperCase();
        const name = flags.name ?? `${from} → ${to}`;
        if (config.routes.some((route) => route.name === name))
          throw new Error(
            `A route named "${name}" already exists. Use a different --name or remove it first.`,
          );
        for (const [flag, value] of [
          ["depart", flags.depart],
          ["return", flags.return],
        ] as const) {
          if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value))
            throw new Error(`--${flag} must be YYYY-MM-DD, got "${value}"`);
        }
        const route: Route = {
          name,
          from,
          to,
          roundTrip: Boolean(flags.return),
          departureDate: flags.depart,
          returnDate: flags.return ?? null,
          flexDays: numberFlag(flags.flex, "flex") ?? 0,
          currency: flags.currency ?? "BRL",
          maxStops: numberFlag(flags.stops, "stops"),
          maxBudget: numberFlag(flags.budget, "budget"),
          maxDurationHours: numberFlag(flags.duration, "duration"),
          active: true,
        };
        config.routes.push(route);
        writeJson(configPath, config);
        stdout(json({ added: route, totalRoutes: config.routes.length }));
        return 0;
      }
      case "pause":
      case "resume": {
        const name = rest[0];
        if (!name) throw new Error(`usage: config-route.ts ${command} "Route Name"`);
        const route = findRoute(name);
        route.active = command === "resume";
        writeJson(configPath, config);
        stdout(json({ route: route.name, active: route.active }));
        return 0;
      }
      case "reset": {
        const name = rest[0];
        if (!name) throw new Error('usage: config-route.ts reset "Route Name"');
        findRoute(name);
        const prices = readJson(pricesPath, {}) as PricesFile;
        if (!(name in prices)) {
          stdout(json({ route: name, cleared: false, reason: "no price history" }));
          return 0;
        }
        const previous = prices[name];
        delete prices[name];
        writeJson(pricesPath, prices);
        stdout(json({ route: name, cleared: true, previous }));
        return 0;
      }
      default:
        throw new Error(
          `unknown command "${command ?? ""}". Use: list | add | pause | resume | reset`,
        );
    }
  } catch (error) {
    return fail((error as Error).message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  runRouteManager({ argv: process.argv.slice(2) });
