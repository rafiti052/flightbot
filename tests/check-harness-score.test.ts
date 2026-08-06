import { describe, expect, it, vi } from "vitest";
import { parseHarnessScore, runHarnessCheck } from "../scripts/check-harness-score.ts";

describe("parseHarnessScore", () => {
  it("reads plain and noisy JSON score output", () => {
    expect(parseHarnessScore('{"score":{"percent":70}}')).toBe(70);
    expect(parseHarnessScore('scanner started\n{"score":{"percent":88.5}}\nscanner complete')).toBe(
      88.5,
    );
  });

  it("rejects malformed JSON and missing score percentages", () => {
    expect(() => parseHarnessScore("not JSON")).toThrow("did not contain score.percent");
    expect(() => parseHarnessScore('{"score":{}}')).toThrow("did not contain score.percent");
  });
});

describe("runHarnessCheck", () => {
  it("fails when the scanner command fails", () => {
    expect(() =>
      runHarnessCheck({
        execute: () => {
          throw new Error("scanner unavailable");
        },
      }),
    ).toThrow("Harness score command failed: scanner unavailable");
  });

  it("fails below 70 and passes at and above the threshold", () => {
    expect(() => runHarnessCheck({ execute: () => '{"score":{"percent":69.99}}' })).toThrow(
      "Harness score 69.99% is below the required 70%.",
    );

    const output = { log: vi.fn(), error: vi.fn() };
    expect(runHarnessCheck({ execute: () => '{"score":{"percent":70}}', output })).toBe(70);
    expect(runHarnessCheck({ execute: () => '{"score":{"percent":91.25}}', output })).toBe(91.25);
    expect(output.log).toHaveBeenCalledWith("Harness score 70% meets the required 70%.");
    expect(output.log).toHaveBeenCalledWith("Harness score 91.25% meets the required 70%.");
  });
});
