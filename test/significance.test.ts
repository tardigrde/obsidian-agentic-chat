import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNIFICANCE_RESAMPLES,
  DEFAULT_SIGNIFICANCE_SEED,
  bootstrapCompare,
  formatSignificance,
  type SignificanceCase,
} from "../scripts/eval/significance";

function cases(scores: ReadonlyArray<[string, number, number?]>): SignificanceCase[] {
  return scores.map(([id, passAtK, passRate]) => ({ id, passAtK, passRate }));
}

/** Ten cases, one failing; a flip of `case.9` changes the mean by 10 points. */
const TEN_LOW: SignificanceCase[] = Array.from({ length: 10 }, (_, index) => ({
  id: `case.${index}`,
  passAtK: index < 9 ? 1 : 0,
  passRate: index < 9 ? 1 : 0,
}));

describe("bootstrapCompare", () => {
  it("reports no difference for identical inputs", () => {
    const input = cases([
      ["a", 1, 1],
      ["b", 0, 0.5],
      ["c", 1, 0.75],
    ]);
    const result = bootstrapCompare(input, structuredClone(input));

    expect(result.paired).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(result.flips).toEqual([]);
    expect(result.seed).toBe(DEFAULT_SIGNIFICANCE_SEED);
    expect(result.resamples).toBe(DEFAULT_SIGNIFICANCE_RESAMPLES);

    const passAtK = result.metrics.find((metric) => metric.metric === "passAtK");
    expect(passAtK).toMatchObject({
      before: 2 / 3,
      after: 2 / 3,
      difference: 0,
      lower: 0,
      upper: 0,
      significant: false,
    });
    const passRate = result.metrics.find((metric) => metric.metric === "passRate");
    expect(passRate).toMatchObject({ difference: 0, lower: 0, upper: 0, significant: false });
  });

  it("calls an all-pass vs all-fail difference significant", () => {
    const before = cases([
      ["a", 0, 0],
      ["b", 0, 0],
      ["c", 0, 0],
    ]);
    const after = cases([
      ["a", 1, 1],
      ["b", 1, 1],
      ["c", 1, 1],
    ]);
    const result = bootstrapCompare(before, after);
    const passAtK = result.metrics.find((metric) => metric.metric === "passAtK");
    expect(passAtK).toMatchObject({ difference: 1, lower: 1, upper: 1, significant: true });
    expect(result.flips).toHaveLength(3);
    expect(result.flips[0]).toMatchObject({ passAtKChange: 1, passRateChange: 1 });
  });

  it("does not call one flipped case in ten significant", () => {
    const before = TEN_LOW;
    const after = before.map((entry) =>
      entry.id === "case.9" ? { ...entry, passAtK: 1, passRate: 1 } : entry,
    );
    const result = bootstrapCompare(before, after);
    const passAtK = result.metrics.find((metric) => metric.metric === "passAtK");
    expect(passAtK?.difference).toBeCloseTo(0.1, 10);
    expect(passAtK?.lower).toBe(0);
    expect(passAtK?.upper).toBeGreaterThan(0);
    expect(passAtK?.significant).toBe(false);
    expect(result.flips).toEqual([
      { id: "case.9", passAtKChange: 1, passRateChange: 1 },
    ]);
  });

  it("is byte-identical for the same seed and close for another seed", () => {
    const before = cases([
      ["a", 1, 1],
      ["b", 1, 0.66],
      ["c", 0, 0.33],
      ["d", 1, 1],
      ["e", 0, 0],
    ]);
    const after = cases([
      ["a", 1, 1],
      ["b", 0, 0.33],
      ["c", 1, 0.66],
      ["d", 1, 1],
      ["e", 0, 0],
    ]);
    const first = bootstrapCompare(before, after);
    const again = bootstrapCompare(before, after);
    expect(formatSignificance(again, { before: "Baseline", after: "Candidate" })).toBe(
      formatSignificance(first, { before: "Baseline", after: "Candidate" }),
    );

    const other = bootstrapCompare(before, after, { seed: 999 });
    for (const metric of first.metrics) {
      const shifted = other.metrics.find((entry) => entry.metric === metric.metric);
      expect(shifted?.difference).toBeCloseTo(metric.difference, 10);
      expect(Math.abs((shifted?.lower ?? 0) - metric.lower)).toBeLessThanOrEqual(0.2);
      expect(Math.abs((shifted?.upper ?? 0) - metric.upper)).toBeLessThanOrEqual(0.2);
      expect(shifted?.significant).toBe(metric.significant);
    }
  });

  it("skips a case that is missing on one side and names it", () => {
    const before = cases([
      ["a", 1, 1],
      ["b", 0, 0],
      ["gone", 1, 1],
    ]);
    const after = cases([
      ["a", 1, 1],
      ["b", 0, 0],
    ]);
    const result = bootstrapCompare(before, after);
    expect(result.paired).toBe(2);
    expect(result.skipped).toEqual([{ id: "gone", side: "after" }]);
    expect(result.warnings).toEqual(["skipped gone: missing in candidate"]);
    expect(result.metrics.find((metric) => metric.metric === "passAtK")?.difference).toBe(0);
  });

  it("falls back to passAtK when an old baseline has no passRate", () => {
    const before = cases([
      ["a", 1],
      ["b", 0],
    ]);
    const after = cases([
      ["a", 1, 1],
      ["b", 1, 0.5],
    ]);
    const result = bootstrapCompare(before, after);
    expect(result.warnings).toContain(
      "passRate is missing on at least one side; passAtK is used for both metrics",
    );
    const passRate = result.metrics.find((metric) => metric.metric === "passRate");
    expect(passRate).toMatchObject({ fallbackFrom: "passAtK", before: 0.5, after: 1 });
    expect(passRate?.difference).toBe(result.metrics.find((m) => m.metric === "passAtK")?.difference);

    const markdown = formatSignificance(result, { before: "off", after: "low" });
    expect(markdown).toContain("| pass@1 (passAtK fallback) |");
    expect(markdown).toContain("passAtK is used for both metrics");
    expect(markdown).toContain("2000 resamples, seed 12345");
  });

  it("prints the excluded case and the verdict", () => {
    const before = TEN_LOW;
    const after = before.map((entry) =>
      entry.id === "case.9" ? { ...entry, passAtK: 1, passRate: 1 } : entry,
    );
    const markdown = formatSignificance(bootstrapCompare(before, after), { before: "off", after: "low" }, [
      "tools.medium.web",
    ]);
    expect(markdown).toContain("| Metric | off | low | Difference | 95% CI | Verdict |");
    expect(markdown).toContain("| pass^K | 90% | 100% | +10 pp |");
    expect(markdown).toContain("not significant (CI includes 0)");
    expect(markdown).toContain("Excluded: tools.medium.web.");
    expect(markdown).toContain("| case.9 | +1 | +100 pp |");
  });
});
