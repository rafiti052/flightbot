import { execFileSync } from "node:child_process";

const THRESHOLD = 70;

type Executor = (command: string, args: string[]) => string;
type Output = Pick<Console, "log" | "error">;

export function parseHarnessScore(output: string): number {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    if (quoted) {
      if (!escaped && char === '"') quoted = false;
      escaped = !escaped && char === "\\";
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) candidates.push(output.slice(start, index + 1));
    }
  }

  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as { score?: { percent?: unknown } };
      if (typeof parsed.score?.percent === "number" && Number.isFinite(parsed.score.percent)) {
        return parsed.score.percent;
      }
    } catch {
      // Continue looking for the score object among command noise.
    }
  }
  throw new Error("Harness score output did not contain score.percent JSON.");
}

const executePinnedHarnessScore: Executor = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function runHarnessCheck({
  execute = executePinnedHarnessScore,
  output = console,
}: { execute?: Executor; output?: Output } = {}): number {
  let raw: string;
  try {
    raw = execute("pnpm", ["exec", "harness-score", "--json"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Harness score command failed: ${message}`, { cause: error });
  }

  const percent = parseHarnessScore(raw);
  if (percent < THRESHOLD) {
    throw new Error(`Harness score ${percent}% is below the required ${THRESHOLD}%.`);
  }
  output.log(`Harness score ${percent}% meets the required ${THRESHOLD}%.`);
  return percent;
}

export function main(output: Output = console): void {
  try {
    runHarnessCheck({ output });
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("check-harness-score.ts")) main();
