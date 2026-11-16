import { describe, expect, it } from "vitest";
import {
  bootstrapCompare,
  formatSignificance,
  type SignificanceCase,
} from "../scripts/eval/significance";

function cases(scores: ReadonlyArray<[string, number, number?]>): SignificanceCase[] {
  return scores.map(([id, passAllK, passRate]) => ({ id, passAllK, passRate }));
}

/** Ten cases, one failing; a flip of `case.9` changes the mean by 10 points. */
const TEN_LOW: SignificanceCase[] = Array.from({ length: 10 }, (_, index) => ({
  id: `case.${index}`,
  passAllK: index < 9 ? 1 : 0,
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
    expect(result.seed).toBe(12345);
    expect(result.resamples).toBe(2000);

    const passAllK = result.metrics.find((metric) => metric.metric === "passAllK");
    expect(passAllK).toMatchObject({
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
    const passAllK = result.metrics.find((metric) => metric.metric === "passAllK");
    expect(passAllK).toMatchObject({ difference: 1, lower: 1, upper: 1, significant: true });
    expect(result.flips).toHaveLength(3);
    expect(result.flips[0]).toMatchObject({ passAllKChange: 1, passRateChange: 1 });
  });

  it("does not call one flipped case in ten significant", () => {
    const before = TEN_LOW;
    const after = before.map((entry) =>
      entry.id === "case.9" ? { ...entry, passAllK: 1, passRate: 1 } : entry,
    );
    const result = bootstrapCompare(before, after);
    const passAllK = result.metrics.find((metric) => metric.metric === "passAllK");
    expect(passAllK?.difference).toBeCloseTo(0.1, 10);
    expect(passAllK?.lower).toBe(0);
    expect(passAllK?.upper).toBeGreaterThan(0);
    expect(passAllK?.significant).toBe(false);
    expect(result.flips).toEqual([
      { id: "case.9", passAllKChange: 1, passRateChange: 1 },
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

  it("resamples with the requested seed, not only the reported one", () => {
    const before: SignificanceCase[] = Array.from({ length: 25 }, (_, index) => ({
      id: `case.${String(index).padStart(2, "0")}`,
      passAllK: index % 3 === 0 ? 0 : 1,
      passRate: index % 4 === 0 ? 1 / 3 : index % 5 === 0 ? 2 / 3 : 1,
    }));
    const after = before.map((entry, index) => ({
      ...entry,
      passAllK: index < 7 ? 1 - entry.passAllK : entry.passAllK,
      passRate: index % 3 === 0 ? 0.5 : entry.passRate,
    }));
    const standard = bootstrapCompare(before, after);
    expect(standard.seed).toBe(12345);
    const other = bootstrapCompare(before, after, { seed: 7 });
    expect(other.seed).toBe(7);

    // A mutation that ignores the requested seed produces the same bounds for
    // both calls. The observed means are seed-independent; the interval is not.
    const bounds = (result: typeof standard) =>
      result.metrics.flatMap((metric) => [metric.metric, metric.lower, metric.upper]);
    expect(bounds(other)).not.toEqual(bounds(standard));
    expect(other.metrics.map((metric) => metric.difference)).toEqual(
      standard.metrics.map((metric) => metric.difference),
    );
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
    expect(result.skipped).toEqual([{ id: "gone", side: "after", reason: "missing" }]);
    expect(result.warnings).toEqual(["skipped gone: missing in candidate"]);
    expect(result.metrics.find((metric) => metric.metric === "passAllK")?.difference).toBe(0);
  });

  it("skips a case with a non-finite score and names it", () => {
    const before = cases([
      ["a", 1, 1],
      ["b", Number.NaN, 0.5],
      ["c", 0, Number.POSITIVE_INFINITY],
    ]);
    const after = cases([
      ["a", 1, 1],
      ["b", 1, 0.5],
      ["c", 0, 1],
    ]);
    const result = bootstrapCompare(before, after);
    expect(result.paired).toBe(1);
    expect(result.skipped).toEqual([
      { id: "b", side: "before", reason: "invalid" },
      { id: "c", side: "before", reason: "invalid" },
    ]);
    expect(result.warnings).toEqual([
      "skipped b: invalid passAllK in baseline",
      "skipped c: invalid passRate in baseline",
    ]);
    expect(result.metrics.every((metric) => Number.isFinite(metric.difference))).toBe(true);
  });

  it("falls back to passAllK when an old baseline has no passRate", () => {
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
      "passRate is missing on at least one side; passAllK is used for both metrics",
    );
    const passRate = result.metrics.find((metric) => metric.metric === "passRate");
    expect(passRate).toMatchObject({ fallbackFrom: "passAllK", before: 0.5, after: 1 });
    expect(passRate?.difference).toBe(result.metrics.find((m) => m.metric === "passAllK")?.difference);

    const markdown = formatSignificance(result, { before: "off", after: "low" });
    expect(markdown).toContain("| pass@1 (passAllK fallback) |");
    expect(markdown).toContain("passAllK is used for both metrics");
    expect(markdown).toContain("2000 resamples, seed 12345");
  });

  it("prints the excluded case and the verdict", () => {
    const before = TEN_LOW;
    const after = before.map((entry) =>
      entry.id === "case.9" ? { ...entry, passAllK: 1, passRate: 1 } : entry,
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
