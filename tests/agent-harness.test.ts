import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function expectSkill(skill: string, required: string[]) {
  const directory = path.join(root, ".agents/skills", skill);
  const contents = read(`.agents/skills/${skill}/SKILL.md`);
  expect(contents).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---`, "s"));
  expect(fs.existsSync(path.join(directory, "agents/openai.yaml"))).toBe(true);
  for (const text of required) expect(contents).toContain(text);
  for (const assistant of [".claude", ".cursor", ".windsurf"]) {
    const link = path.join(root, assistant, "skills", skill);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(directory);
  }
}

describe("agent harness contracts", () => {
  it("provides linked route guidance that uses only the maintained CLI", () => {
    expectSkill("route-management", [
      "pnpm exec tsx scripts/config-route.ts list",
      "explicit confirmation",
      "temporary backup",
      "Never edit `config.json`, `prices.json`, `.env`, or `results.log` directly.",
    ]);
  });

  it("provides linked deploy guidance with a final human mutation gate", () => {
    expectSkill("deploy-safety", [
      "Default to read-only preflight.",
      "ask for explicit confirmation",
      "scripts/deploy.sh",
      "Never remove containers, volumes, images, or services",
    ]);
  });

  it("keeps the scrape debugger diagnostic-only and exposes TLC to Windsurf", () => {
    const agent = read(".claude/agents/scrape-debugger.md");
    expect(agent).toMatch(
      /^---\nname: scrape-debugger\ndescription: .+\ntools: Read, Grep, Glob, Bash\n---/s,
    );
    expect(agent).toContain("pnpm exec tsx scripts/test-scrape.ts --no-send --json");
    for (const policy of [
      "Never edit or write files",
      "config.json`, `prices.json`, `results.log`, or secrets",
      "send Telegram",
      "explicitly authorizes",
    ])
      expect(agent).toContain(policy);
    const link = path.join(root, ".windsurf/skills/tlc-spec-driven");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(path.join(root, ".agents/skills/tlc-spec-driven"));
  });
});
