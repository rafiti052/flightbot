import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("quality workflow", () => {
  it("runs the deterministic repository gates with a locked Node and pnpm toolchain", () => {
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("push:");
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n\nconcurrency:/);
    expect(workflow).toContain("actions/checkout@v4");
    expect(workflow).toMatch(/pnpm\/action-setup@v4[\s\S]*version: 11\.5\.1/);
    expect(workflow).toMatch(/actions\/setup-node@v4[\s\S]*node-version: 22[\s\S]*cache: pnpm/);
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("pnpm run check");
    expect(workflow).toContain("pnpm run harness:check");
    expect(workflow).toContain("git ls-files '*.sh' | xargs -r bash -n");
  });

  it("does not grant secrets or run live operational commands", () => {
    expect(workflow).not.toMatch(/secrets\.|docker|deploy|install-browsers|test-scrape/i);
  });
});
