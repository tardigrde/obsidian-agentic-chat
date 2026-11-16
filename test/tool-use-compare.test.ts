import { describe, expect, it } from "vitest";
import { formatComparison, paretoCompare } from "../scripts/eval/tool-use-compare";

const caseRow = (id: string, overrides: Record<string, number> = {}) => ({
  id,
  passRate: 1,
  passAllK: 1,
  partialScore: 1,
  meanTokens: 1_000,
  meanUsd: 0.01,
  medianMs: 1_000,
  ...overrides,
});

describe("tool-use comparison", () => {
  it("shows a case that exists on one side as missing there, never as zero", () => {
    const text = formatComparison(
      { cases: [caseRow("case.kept"), caseRow("case.removed")] },
      { cases: [caseRow("case.kept"), caseRow("case.new", { passRate: 0.5 })] },
    );
    expect(text).toContain("| case.new | (missing) | (missing) -> 50% |");
    expect(text).toMatch(/\| case\.new \|.*\| new case \|/);
    expect(text).toContain("| case.removed | (missing) | 100% -> (missing) |");
    expect(text).toMatch(/\| case\.removed \|.*\| removed case \|/);
    expect(text).toContain("| case.kept | (missing) | 100% -> 100% (0) |");
  });

  it("shows a metric that an older baseline lacks as missing", () => {
    const { passAllK: _passAllK, ...older } = caseRow("case.one");
    const text = formatComparison({ cases: [older] }, { cases: [caseRow("case.one")] });
    expect(text).toContain("| case.one | (missing) | 100% -> 100% (0) | (missing) -> 1 |");
    expect(text).toContain("| pass^K | (missing) | (missing) | (missing) |");
  });

  it("warns when the suite or the model differs", () => {
    const text = formatComparison(
      { suite: "core", model: "model-a", cases: [] },
      { suite: { name: "tool-use" }, model: "model-b", cases: [] },
    );
    expect(text).toContain("> Warning: the suite differs (baseline `core`, candidate `tool-use`).");
    expect(text).toContain("> Warning: the model differs (baseline `model-a`, candidate `model-b`).");
  });

  it("prints no warning for a baseline and a summary of the same suite and model", () => {
    const text = formatComparison(
      { suite: "core", model: "model-a", cases: [] },
      { suite: { name: "core" }, model: "model-a", cases: [] },
    );
    expect(text).not.toContain("Warning");
  });

  it("flags only growth above 20% and any pass-rate drop", () => {
    const text = formatComparison(
      { cases: [caseRow("case.cost"), caseRow("case.steady"), caseRow("case.pass")] },
      {
        cases: [
          caseRow("case.cost", { meanUsd: 0.013, medianMs: 1_100 }),
          caseRow("case.steady", { meanUsd: 0.012, medianMs: 1_200 }),
          caseRow("case.pass", { passRate: 0.9 }),
        ],
      },
    );
    expect(text).toMatch(/\| case\.cost \|.*\| cost \+30% \|/);
    expect(text).toMatch(/\| case\.steady \|.*\| - \|/);
    expect(text).toMatch(/\| case\.pass \|.*\| pass -10 \|/);
  });

  describe("Pareto verdict on correctness, cost, and time", () => {
    const run = (passAllK: number, meanUsd: number, medianCaseMs: number) => ({
      overall: { passAllK, meanUsd, medianCaseMs },
    });
    const base = run(0.8, 0.001, 10_000);

    it("dominates when one axis is better and none is worse", () => {
      expect(paretoCompare(base, run(0.8, 0.0005, 10_000))).toMatchObject({
        verdict: "dominates",
        better: ["cost"],
        same: ["correctness", "time"],
      });
    });

    it("calls a correctness gain that costs more a trade-off, not a win", () => {
      expect(paretoCompare(base, run(0.88, 0.0015, 10_000))).toMatchObject({
        verdict: "trade-off",
        better: ["correctness"],
        worse: ["cost"],
      });
    });

    it("is dominated when one axis is worse and none is better", () => {
      expect(paretoCompare(base, run(0.8, 0.001, 20_000)).verdict).toBe("dominated");
    });

    it("treats a cost or time change inside the noise share as the same", () => {
      expect(paretoCompare(base, run(0.8, 0.00105, 10_900)).verdict).toBe("same");
    });

    it("reads a change of exactly 10% as the same, despite float error", () => {
      expect(paretoCompare(base, run(0.8, 0.0011, 11_000)).verdict).toBe("same");
    });

    it("does not call a tiny cost change on a zero-cost baseline a loss", () => {
      expect(paretoCompare(run(0.8, 0, 10_000), run(0.8, 0.0000005, 10_000)).verdict).toBe("same");
    });

    it("gives no verdict when an axis is missing on one side", () => {
      expect(paretoCompare(base, { overall: { passAllK: 1, meanUsd: 0.001 } })).toMatchObject({
        verdict: "incomplete",
        missing: ["time"],
      });
    });

    it("prints the verdict under the overall table", () => {
      expect(formatComparison(base, run(0.8, 0.0005, 10_000))).toContain(
        "Pareto (correctness, cost, time): **dominates**",
      );
    });
  });
});
