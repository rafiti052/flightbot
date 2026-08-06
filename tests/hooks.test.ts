import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const preHook = resolve(root, ".claude/hooks/pre-tool-use.sh");
const postHook = resolve(root, ".claude/hooks/post-tool-use.sh");

function runHook(script: string, input: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [script], {
    input,
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
}

function preDecision(command: string) {
  const result = runHook(preHook, JSON.stringify({ tool_input: { command } }));
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout).hookSpecificOutput;
}

describe("Claude hooks", () => {
  it("uses the command-hook schema", async () => {
    const settings = await import("../.claude/settings.json", { with: { type: "json" } });
    expect(settings.default.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(settings.default.hooks.PostToolUse[0].matcher).toBe("Edit|Write");
  });

  it("allows benign commands without matching quoted text", () => {
    expect(preDecision("git status").permissionDecision).toBe("allow");
    expect(preDecision("echo 'rm -rf /tmp/example'").permissionDecision).toBe("allow");
  });

  it("asks before deployment and Docker removal or shutdown", () => {
    for (const command of [
      "scripts/deploy.sh",
      "pnpm run deploy",
      "docker rm container",
      "docker compose down",
    ]) {
      expect(preDecision(command).permissionDecision).toBe("ask");
    }
  });

  it("denies destructive command variants and malformed input", () => {
    for (const command of [
      "rm -rf tmp",
      "rm -fr tmp",
      "rm --recursive --force tmp",
      "git reset --hard HEAD",
      "git push --force-with-lease origin main",
    ]) {
      expect(preDecision(command).permissionDecision).toBe("deny");
    }
    const result = runHook(preHook, "not json");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("ignores non-code paths and formatter failures", () => {
    const ignored = runHook(
      postHook,
      JSON.stringify({ tool_input: { file_path: resolve(root, "README.md") } }),
    );
    expect(ignored.status).toBe(0);
    const bin = mkdtempSync(resolve(tmpdir(), "flightbot-hook-"));
    const failingPnpm = resolve(bin, "pnpm");
    writeFileSync(failingPnpm, "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(failingPnpm, 0o755);
    const repairFailure = runHook(
      postHook,
      JSON.stringify({ tool_input: { file_path: resolve(root, "bot.ts") } }),
      {
        PATH: `${bin}:/opt/homebrew/bin:/bin:/usr/bin`,
      },
    );
    expect(repairFailure.status).toBe(0);
  });

  it("keeps hook scripts executable", () => {
    expect(statSync(preHook).mode & 0o111).not.toBe(0);
    expect(statSync(postHook).mode & 0o111).not.toBe(0);
  });
});
