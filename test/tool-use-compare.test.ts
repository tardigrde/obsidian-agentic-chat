import { describe, expect, it } from "vitest";
import { abCommand, formatComparison, paretoCompare } from "../scripts/eval/tool-use-compare";

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

  it("prints no warning for a baseline and a summary of the same suite, model, and cost source", () => {
    const text = formatComparison(
      { suite: "core", model: "model-a", costSource: "billed", cases: [] },
      { suite: { name: "core" }, model: "model-a", costSource: "billed", cases: [] },
    );
    expect(text).not.toContain("Warning");
  });

  it("flags only growth above 20% and any pass-rate drop", () => {
    const text = formatComparison(
      { costSource: "billed", cases: [caseRow("case.cost"), caseRow("case.steady"), caseRow("case.pass")] },
      {
        costSource: "billed",
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

  it("marks a pass drop at n=3 as thin and prints one eval:ab command for the flagged cases (#392 item 2)", () => {
    const text = formatComparison(
      { cases: [caseRow("organize.easy.invoice", { executed: 3 }), caseRow("tools.easy.search", { executed: 3 }), caseRow("edit.easy.typo", { executed: 3 })] },
      {
        cases: [
          caseRow("organize.easy.invoice", { executed: 3, passRate: 2 / 3 }),
          caseRow("tools.easy.search", { executed: 3, passRate: 1 / 3 }),
          caseRow("edit.easy.typo", { executed: 3 }),
        ],
      },
    );
    expect(text).toMatch(/\| organize\.easy\.invoice \|.*\| pass -33 \(n=3, check with eval:ab\) \|/);
    expect(text).toMatch(/\| tools\.easy\.search \|.*\| pass -67 \(n=3, check with eval:ab\) \|/);
    expect(text).toContain("npm run eval:ab -- --case organize.easy.invoice,tools.easy.search --runs 5");
    expect(text).not.toContain("edit.easy.typo --runs");
  });

  it("keeps a bare pass flag at n>=5, and reads n from an old baseline's overall", () => {
    const five = formatComparison({ cases: [caseRow("a", { executed: 5 })] }, { cases: [caseRow("a", { executed: 5, passRate: 0.8 })] });
    expect(five).toMatch(/\| a \|.*\| pass -20 \|/);
    expect(five).not.toContain("eval:ab");
    const old = formatComparison(
      { overall: { runs: 81, cases: 27 }, cases: [caseRow("a")] },
      { cases: [caseRow("a", { executed: 3, passRate: 2 / 3 })] },
    );
    expect(old).toContain("pass -33 (n=3, check with eval:ab)");
    expect(abCommand(["x"], 7)).toBe("npm run eval:ab -- --case x --runs 7");
  });

  it("shows the median run cost and notes when the mean and the median move in opposite directions (#392 item 3)", () => {
    const runs = (...usd: number[]) => usd.map((value, index) => ({ run: index + 1, status: "pass", usd: value }));
    const base = { costSource: "billed", cases: [{ ...caseRow("long"), meanUsd: 0.004, runResults: runs(0.003, 0.004, 0.005) }] };
    const head = { costSource: "billed", cases: [{ ...caseRow("long"), meanUsd: 0.006, runResults: runs(0.002, 0.002, 0.014) }] };
    const text = formatComparison(base, head);
    expect(text).toContain("$0.004000 -> $0.002000 (-$0.002000)");
    expect(text).toContain("The mean and the median disagree on the direction");
    const same = formatComparison(base, { costSource: "billed", cases: [{ ...caseRow("long"), meanUsd: 0.005, runResults: runs(0.004, 0.005, 0.006) }] });
    expect(same).toContain("Robust cost: per-case medians sum");
    expect(same).not.toContain("disagree");
  });

  describe("Pareto verdict on correctness, cost, and time", () => {
    const run = (passAllK: number, meanUsd: number, medianCaseMs: number, costSource = "billed") => ({
      costSource,
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

    it("never ranks a price-table cost against a billed cost", () => {
      const table = run(0.8, 0.0004, 10_000, "table");
      expect(paretoCompare(table, run(0.8, 0.001, 10_000))).toMatchObject({
        verdict: "incomplete",
        missing: ["cost"],
      });
      expect(formatComparison(table, run(0.8, 0.001, 10_000))).toContain("the cost axis is not compared");
    });

    it("hides the per-case cost flag when the cost sources differ", () => {
      const text = formatComparison(
        { costSource: "table", cases: [caseRow("case.cost")] },
        { costSource: "billed", cases: [caseRow("case.cost", { meanUsd: 0.05 })] },
      );
      expect(text).not.toContain("cost +");
    });

    it("never compares cost for a run that spent nothing", () => {
      expect(paretoCompare(run(0.8, 0, 10_000, "none"), run(0.8, 0, 10_000, "none")).missing).toEqual(["cost"]);
    });

    it("treats a file with no cost source (an old baseline) as unknown", () => {
      const old = { overall: { passAllK: 0.8, meanUsd: 0.001, medianCaseMs: 10_000 } };
      expect(paretoCompare(old, run(0.8, 0.001, 10_000)).missing).toEqual(["cost"]);
    });

    it("gives no verdict when an axis is missing on one side", () => {
      expect(paretoCompare(base, { costSource: "billed", overall: { passAllK: 1, meanUsd: 0.001 } })).toMatchObject({
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
