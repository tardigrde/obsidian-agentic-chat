import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canarySignal, formatCanary, wilson } from "../scripts/eval/canary";
import { validateToolUseSuite } from "../scripts/eval/tool-use-core";
import { selectCases } from "../scripts/eval/tool-use-plan";

const CANARY = ["organize.easy.invoice", "tools.easy.search", "organize.medium.inbox", "safety.medium.injection", "edit.easy.typo"];

describe("canary slice (#393 T20)", () => {
  const suite = validateToolUseSuite(JSON.parse(readFileSync("test/evals/tool-use/core.eval.json", "utf8")));

  it("selectCases(..., {canary: true}) returns the 5 ids in order", () => {
    expect(selectCases(suite, { canary: true }).map((entry) => entry.id)).toEqual(CANARY);
  });

  it("refuses --canary with --case or --smoke, and a suite without the slice", () => {
    expect(() => selectCases(suite, { canary: true, caseIds: ["edit.easy.typo"] })).toThrow("--canary cannot be combined with --case");
    expect(() => selectCases(suite, { canary: true, smoke: true })).toThrow("--smoke cannot be combined with --canary");
    const { canary: _canary, ...without } = suite;
    expect(() => selectCases(without, { canary: true })).toThrow("defines no canary slice");
  });

  it("rejects a canary id that is not a case", () => {
    const raw = JSON.parse(readFileSync("test/evals/tool-use/core.eval.json", "utf8"));
    expect(() => validateToolUseSuite({ ...raw, canary: ["nope"] })).toThrow("suite.canary[0] is not a case id in this suite: nope.");
  });
});

describe("Wilson interval and the signal rule", () => {
  it("matches the textbook interval", () => {
    const { lower, upper } = wilson(4, 5);
    expect(lower).toBeCloseTo(0.3755, 3);
    expect(upper).toBeCloseTo(0.9638, 3);
    expect(wilson(0, 0)).toEqual({ lower: 0, upper: 1 });
  });

  it("calls 4/5 -> 0/5 and 5/5 -> 3/5 drops (card 1), and 67% -> 4/5 noise", () => {
    expect(canarySignal(0, 5, 0.8)).toBe("drop");
    expect(canarySignal(3, 5, 1)).toBe("drop");
    expect(canarySignal(4, 5, 2 / 3)).toBe("noise");
    expect(canarySignal(5, 5, 0.2)).toBe("gain");
    expect(canarySignal(5, 5, undefined)).toBe("no baseline");
  });

  it("prints one row per case and names the moved cases", () => {
    const text = formatCanary(
      { cases: [{ id: "a", passed: 0, executed: 5 }, { id: "b", passed: 4, executed: 5 }] },
      { cases: [{ id: "a", passRate: 0.8 }, { id: "b", passRate: 2 / 3 }] },
    );
    expect(text).toContain("| a | 0/5 | [0%, 43%] | 80% | drop |");
    expect(text).toContain("| b | 4/5 | [38%, 96%] | 67% | noise |");
    expect(text).toContain("Signal: a (drop).");
    expect(formatCanary({ cases: [{ id: "a", passed: 5, executed: 5 }] }, undefined)).toContain("No baseline: nothing to compare against.");
  });
});
