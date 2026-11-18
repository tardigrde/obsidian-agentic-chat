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

  it("calls one weak move Weak (the two main runs of 2026-11-18), and a strong or repeated move a Signal", () => {
    const base = { cases: [{ id: "search", passRate: 1 }, { id: "invoice", passRate: 2 / 3 }, { id: "typo", passRate: 1 }] };
    const run = (search: number, invoice: number, typo: number) =>
      formatCanary(
        { cases: [{ id: "search", passed: search, executed: 5 }, { id: "invoice", passed: invoice, executed: 5 }, { id: "typo", passed: typo, executed: 5 }] },
        base,
      );
    // Unchanged main: search 4/5 then 3/5 against 3/3 is one case outside its interval.
    expect(run(4, 4, 5)).toContain("Weak: search (drop). One case outside its interval is common at 5 runs");
    expect(run(3, 3, 5)).toContain("Weak: search (drop).");
    // 1/5 against 100% is 80 points: a signal on its own.
    expect(run(1, 4, 5)).toContain("Signal: search (drop).");
    // Two cases down together: a signal.
    expect(run(4, 4, 4)).toContain("Signal: search (drop), typo (drop).");
    expect(run(5, 4, 5)).toContain("No signal: every baseline rate is inside its interval.");
  });

  it("names a case with no baseline row instead of claiming every rate is inside", () => {
    const text = formatCanary(
      { cases: [{ id: "a", passed: 5, executed: 5 }, { id: "new", passed: 5, executed: 5 }] },
      { cases: [{ id: "a", passRate: 1 }] },
    );
    expect(text).toContain("| new | 5/5 | [57%, 100%] | - | no baseline |");
    expect(text).toContain("No signal in the cases with a baseline. No baseline for: new.");
    expect(text).not.toContain("every baseline rate is inside");
  });

  it("leaves harness-error runs (an upstream 429) out of the interval instead of counting them as failures", () => {
    const text = formatCanary(
      {
        cases: [
          { id: "a", passed: 3, executed: 5, runResults: [{ status: "pass" }, { status: "pass" }, { status: "pass" }, { status: "error" }, { status: "error" }] },
          { id: "b", passed: 4, executed: 5, runResults: [{ status: "pass" }, { status: "pass" }, { status: "pass" }, { status: "pass" }, { status: "error" }] },
        ],
      },
      { cases: [{ id: "a", passRate: 1 }, { id: "b", passRate: 1 }] },
    );
    expect(text).toContain("| a | 3/3 |");
    expect(text).toContain("| b | 4/4 |");
    expect(text).toContain("3 harness error run(s) left out of the intervals");
    expect(text).toContain("No signal");
  });
});

