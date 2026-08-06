import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../.agents/skills/tlc-spec-driven/scripts/check_commit.ts";
const files: string[] = [];
afterEach(() => files.splice(0).forEach((f) => fs.rmSync(f, { force: true })));
describe("check_commit", () => {
  it("accepts types/scope/breaking/footer/comments and input modes", () => {
    const f = path.join(os.tmpdir(), `commit-${Date.now()}`);
    files.push(f);
    fs.writeFileSync(f, "# comment\nfix(core)!: keep compatibility\n\nBREAKING CHANGE: expected\n");
    expect(main([f])).toBe(0);
    expect(main(["--message", "docs: update guide"])).toBe(0);
    expect(main([], "test: cover stdin")).toBe(0);
  });
  it("rejects malformed, cases, punctuation, types, and missing footers", () => {
    for (const message of ["bad", "wat: nope", "fix: Upper", "fix: dot.", "fix!: break"])
      expect(main(["--message", message])).toBe(1);
    expect(main([])).toBe(2);
  });
  it("warns at 72 characters without failure", () =>
    expect(main(["--message", `docs: ${"a".repeat(70)}`])).toBe(0));
});
