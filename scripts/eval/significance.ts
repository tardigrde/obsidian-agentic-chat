/**
 * Bootstrap significance for an eval comparison.
 *
 * A 25-case suite cannot tell a two-point change from noise. This module
 * resamples the cases, not the runs: each case is one paired unit, and the
 * statistic is the mean difference (after - before). It is local math only:
 * no model call, no network, no file read.
 *
 * The interval is a percentile bootstrap over cases. It says how much the
 * observed difference depends on which 25 cases the suite happens to hold. It
 * does not model run-to-run variance inside a case, and it is not a promise
 * that a rerun reproduces the number.
 */

export const DEFAULT_SIGNIFICANCE_SEED = 12345;
export const DEFAULT_SIGNIFICANCE_RESAMPLES = 2_000;

export interface SignificanceCase {
  id: string;
  /** 0 or 1: every run of the case passed, or at least one did not. */
  passAtK: number;
  /** 0..1: share of runs that passed. Missing in older baselines. */
  passRate?: number;
}

export interface SignificanceOptions {
  /** Fixed by default so two reads of the same input are byte-identical. */
  seed?: number;
  resamples?: number;
}

export type SignificanceMetric = "passAtK" | "passRate";

export interface MetricSignificance {
  metric: SignificanceMetric;
  before: number;
  after: number;
  difference: number;
  /** 2.5% percentile of the resampled differences. */
  lower: number;
  /** 97.5% percentile of the resampled differences. */
  upper: number;
  /** True when the 95% interval excludes 0. */
  significant: boolean;
  /** Set when the input had no `passRate` and `passAtK` was used instead. */
  fallbackFrom?: "passAtK";
}

export interface CaseFlip {
  id: string;
  passAtKChange: number;
  passRateChange?: number;
}

export interface SkippedCase {
  id: string;
  side: "before" | "after";
}

export interface SignificanceResult {
  seed: number;
  resamples: number;
  /** Cases present on both sides that entered the resampling. */
  paired: number;
  skipped: SkippedCase[];
  warnings: string[];
  metrics: MetricSignificance[];
  /** Only the cases that changed, largest absolute change first. */
  flips: CaseFlip[];
}

interface PairedCase {
  id: string;
  before: SignificanceCase;
  after: SignificanceCase;
}

/**
 * Paired, case-level bootstrap. Draw `n` cases with replacement, take the mean
 * difference for each metric, and report the 2.5% and 97.5% percentiles.
 */
export function bootstrapCompare(
  before: readonly SignificanceCase[],
  after: readonly SignificanceCase[],
  options: SignificanceOptions = {},
): SignificanceResult {
  const seed = options.seed ?? DEFAULT_SIGNIFICANCE_SEED;
  const resamples = options.resamples ?? DEFAULT_SIGNIFICANCE_RESAMPLES;
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new Error(`resamples must be an integer of at least 1, got ${resamples}`);
  }
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );

  const skipped: SkippedCase[] = [];
  const paired: PairedCase[] = [];
  for (const id of ids) {
    const left = beforeById.get(id);
    const right = afterById.get(id);
    if (!left) {
      skipped.push({ id, side: "before" });
      continue;
    }
    if (!right) {
      skipped.push({ id, side: "after" });
      continue;
    }
    paired.push({ id, before: left, after: right });
  }

  const result: SignificanceResult = {
    seed,
    resamples,
    paired: paired.length,
    skipped,
    warnings: skipped.map(
      (entry) =>
        `skipped ${entry.id}: missing in ${entry.side === "before" ? "baseline" : "candidate"}`,
    ),
    metrics: [],
    flips: [],
  };
  if (paired.length === 0) {
    result.warnings.push("no paired cases: nothing to resample");
    return result;
  }

  const hasPassRate = paired.every(
    ({ before: left, after: right }) => isScore(left.passRate) && isScore(right.passRate),
  );
  if (!hasPassRate) {
    result.warnings.push("passRate is missing on at least one side; passAtK is used for both metrics");
  }

  const beforePassAtK = paired.map(({ before: entry }) => entry.passAtK);
  const afterPassAtK = paired.map(({ after: entry }) => entry.passAtK);
  result.metrics.push(
    bootstrapMetric("passAtK", beforePassAtK, afterPassAtK, seed, resamples),
  );

  if (hasPassRate) {
    const beforePassRate = paired.map(({ before: entry }) => entry.passRate as number);
    const afterPassRate = paired.map(({ after: entry }) => entry.passRate as number);
    result.metrics.push(
      bootstrapMetric("passRate", beforePassRate, afterPassRate, seed, resamples),
    );
  } else {
    result.metrics.push({
      ...bootstrapMetric("passRate", beforePassAtK, afterPassAtK, seed, resamples),
      fallbackFrom: "passAtK",
    });
  }

  result.flips = paired
    .map(({ id, before: left, after: right }) => {
      const flip: CaseFlip = {
        id,
        passAtKChange: right.passAtK - left.passAtK,
        passRateChange:
          isScore(left.passRate) && isScore(right.passRate)
            ? right.passRate - left.passRate
            : undefined,
      };
      return flip;
    })
    .filter((flip) => flip.passAtKChange !== 0 || (flip.passRateChange ?? 0) !== 0)
    .sort((left, right) => flipMagnitude(right) - flipMagnitude(left) || left.id.localeCompare(right.id));

  return result;
}

function bootstrapMetric(
  metric: SignificanceMetric,
  before: readonly number[],
  after: readonly number[],
  seed: number,
  resamples: number,
): MetricSignificance {
  const differences: number[] = [];
  const random = mulberry32(seed);
  const count = before.length;
  for (let draw = 0; draw < resamples; draw += 1) {
    let sum = 0;
    for (let pick = 0; pick < count; pick += 1) {
      const index = Math.floor(random() * count);
      sum += after[index] - before[index];
    }
    differences.push(sum / count);
  }
  differences.sort((left, right) => left - right);
  const lower = differences[Math.floor(0.025 * (resamples - 1))];
  const upper = differences[Math.ceil(0.975 * (resamples - 1))];
  const difference = mean(after) - mean(before);
  return {
    metric,
    before: mean(before),
    after: mean(after),
    difference,
    lower,
    upper,
    significant: lower > 0 || upper < 0,
  };
}

/**
 * Mulberry32: 32-bit state, one multiply and a few shifts per draw. Small and
 * deterministic, which is all a bootstrap seed needs here.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isScore(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

function flipMagnitude(flip: CaseFlip): number {
  return Math.max(Math.abs(flip.passAtKChange), Math.abs(flip.passRateChange ?? 0));
}

export interface SignificanceLabels {
  before: string;
  after: string;
}

/** Compact Markdown: the metric table, the excluded cases, warnings, and flips. */
export function formatSignificance(
  result: SignificanceResult,
  labels: SignificanceLabels = { before: "Before", after: "After" },
  excluded: readonly string[] = [],
): string {
  const lines = [
    "## Significance",
    "",
    `Case-level paired bootstrap: ${result.resamples} resamples, seed ${result.seed}, ${result.paired} paired cases. The 95% CI is the 2.5%-97.5% percentile interval.`,
    "",
    `| Metric | ${labels.before} | ${labels.after} | Difference | 95% CI | Verdict |`,
    "|---|---|---|---|---|---|",
  ];
  for (const metric of result.metrics) {
    const name = metric.metric === "passAtK" ? "pass^K" : "pass@1";
    const label = metric.fallbackFrom ? `${name} (passAtK fallback)` : name;
    lines.push(
      `| ${label} | ${percent(metric.before)} | ${percent(metric.after)} | ${points(metric.difference)} | ${interval(metric.lower, metric.upper)} | ${verdict(metric)} |`,
    );
  }
  if (excluded.length > 0) {
    lines.push("", `Excluded: ${excluded.join(", ")}.`);
  }
  if (result.warnings.length > 0) {
    lines.push("", `Warnings: ${result.warnings.join("; ")}.`);
  }
  if (result.flips.length > 0) {
    lines.push("", "Largest case flips (pass^K as cases, pass@1 as pp):", "", "| Case | pass^K | pass@1 |", "|---|---|---|");
    for (const flip of result.flips) {
      const passRate =
        flip.passRateChange === undefined
          ? "(missing)"
          : signed(flip.passRateChange, (number) => `${trimmed((number * 100).toFixed(1))} pp`);
      lines.push(`| ${flip.id} | ${signed(flip.passAtKChange, String)} | ${passRate} |`);
    }
  } else if (result.paired > 0) {
    lines.push("", "No case changed.");
  }
  return `${lines.join("\n")}\n`;
}

function verdict(metric: MetricSignificance): string {
  return metric.significant
    ? `significant (CI excludes 0)`
    : `not significant (CI includes 0)`;
}

function percent(value: number): string {
  const scaled = value * 100;
  const decimals = Number.isInteger(Math.round(scaled * 10) / 10) ? 0 : 1;
  return `${scaled.toFixed(decimals)}%`;
}

/** A difference in percentage points: `0`, `+8 pp`, `-8 pp`. */
function points(value: number): string {
  if (value === 0) return "0";
  return signed(value, (number) => `${trimmed((number * 100).toFixed(1))} pp`);
}

function interval(lower: number, upper: number): string {
  const format = (number: number) => trimmed((number * 100).toFixed(1));
  return `[${signed(lower, format)}, ${signed(upper, format)}] pp`;
}

function signed(value: number, format: (number: number) => string): string {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "-"}${format(Math.abs(value))}`;
}

function trimmed(input: string): string {
  return input.replace(/\.0$/, "");
}
