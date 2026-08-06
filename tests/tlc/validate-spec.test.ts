import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../.agents/skills/tlc-spec-driven/scripts/validate_spec.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});
function fixture(body: string, name = "one") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlc-spec-"));
  dirs.push(root);
  const dir = path.join(root, ".specs/features", name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "spec.md");
  fs.writeFileSync(file, body);
  return { root, dir, file };
}
const valid = `## Problem Statement\nx\n## Out of Scope\nx\n## Assumptions & Open Questions\n| Assumption | Chosen default | Rationale |\n| --- | --- | --- |\n| x | y | z |\n\n**Open questions:** none\n## User Stories\n### Story\n**Acceptance Criteria**:\n1. WHEN x THEN the system SHALL y.\n## Requirement Traceability\n| ID | Status |\n| --- | --- |\n| FOO-01 | verified |\n`;
describe("validate_spec", () => {
  it("accepts valid file, directory, feature name, and autodetect", () => {
    const f = fixture(valid);
    for (const args of [[f.file], [f.dir], ["one", "--root", f.root], ["--root", f.root]])
      expect(main(args)).toBe(0);
  });
  it("reports invalid criteria and strict warnings", () => {
    const f = fixture(valid.replace("SHALL y.", "will y.").replace("FOO-01", "bad"));
    expect(main([f.file])).toBe(1);
    const warning = fixture(valid.replace("WHEN x THEN", "x"));
    expect(main([warning.file])).toBe(0);
    expect(main([warning.file, "--strict"])).toBe(1);
  });
  it("returns 2 for missing and ambiguous targets", () => {
    const missing = fixture(valid);
    expect(main(["none", "--root", missing.root])).toBe(2);
    const second = path.join(missing.root, ".specs/features/two");
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(path.join(second, "spec.md"), valid);
    expect(main(["--root", missing.root])).toBe(2);
  });
});
