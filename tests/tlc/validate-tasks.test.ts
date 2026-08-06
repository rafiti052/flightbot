import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../.agents/skills/tlc-spec-driven/scripts/validate_tasks.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const base = (body: string, name = "one") => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlc-tasks-"));
  dirs.push(root);
  const file = path.join(root, ".specs/features", name, "tasks.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return { root, file };
};
const valid = `## Test Coverage Matrix\n## Gate Check Commands\n## Execution Plan\n\`\`\`\nT01 -> T02\n\`\`\`\n## Task Breakdown\n### Phase 0\n### T01: first\n**Depends on**: None\n**Where**: one.ts\n**Tests**: unit\n**Gate**: quick\n### T02: next\n**Depends on**: T01\n**Where**: two.ts\n**Tests**: unit\n**Gate**: quick\n`;
describe("validate_tasks", () => {
  it("resolves file/name/autodetect", () => {
    const f = base(valid);
    expect(main([f.file])).toBe(0);
    expect(main(["one", "--root", f.root])).toBe(0);
    expect(main(["--root", f.root])).toBe(0);
  });
  it("catches fields, forward dependencies, and diagram mismatch", () => {
    const f = base(
      valid
        .replace("**Gate**: quick\n### T02", "### T02")
        .replace("**Depends on**: T01", "**Depends on**: T99"),
      "one",
    );
    expect(main([f.file])).toBe(1);
    const forward = base(
      valid
        .replace("### Phase 0\n### T01", "### Phase 1\n### T01")
        .replace("### T02: next", "### Phase 0\n### T02: next"),
    );
    expect(main([forward.file])).toBe(1);
  });
  it("handles warnings, strict, missing, and ambiguity", () => {
    const f = base(valid.replace("**Where**: one.ts", "**Where**: one.ts and two.ts"));
    expect(main([f.file])).toBe(0);
    expect(main([f.file, "--strict"])).toBe(1);
    expect(main(["nope", "--root", f.root])).toBe(2);
    const p = path.join(f.root, ".specs/features/two");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "tasks.md"), valid);
    expect(main(["--root", f.root])).toBe(2);
  });
});
