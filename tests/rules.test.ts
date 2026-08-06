import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

const rules = [
  { name: "scraper", paths: ["scraper.ts"] },
  { name: "terminal-ui", paths: ["ui.ts"] },
  { name: "results-log", paths: ["bot.ts", "scripts/lib/format-status.ts"] },
];

describe("path-scoped agent rules", () => {
  it("declares Claude paths and Cursor globs for real source files", () => {
    for (const rule of rules) {
      const canonical = resolve(root, `.agents/rules/${rule.name}.md`);
      const content = readFileSync(canonical, "utf8");
      for (const path of rule.paths) {
        expect(existsSync(resolve(root, path))).toBe(true);
        expect(content).toContain(`  - ${path}`);
      }
      expect(content).toMatch(/^---\npaths:\n[\s\S]+\nglobs:\n[\s\S]+\n---\n/m);
    }
  });

  it("links each assistant surface to the canonical rules", () => {
    for (const rule of rules) {
      const canonical = realpathSync(resolve(root, `.agents/rules/${rule.name}.md`));
      for (const linked of [
        `.claude/rules/${rule.name}.md`,
        `.cursor/rules/${rule.name}.mdc`,
        `.windsurf/rules/${rule.name}.md`,
      ]) {
        const link = resolve(root, linked);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(realpathSync(link)).toBe(canonical);
      }
    }
  });
});
