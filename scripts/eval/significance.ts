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

import { mulberry32 } from "./prng";

export const DEFAULT_SIGNIFICANCE_SEED = 12345;
export const DEFAULT_SIGNIFICANCE_RESAMPLES = 2_000;

export interface SignificanceCase {
  id: string;
  /** 0 or 1: every run of the case passed, or at least one did not. */
  passAllK: number;
  /** 0..1: share of runs that passed. Missing in older baselines. */
  passRate?: number;
  /** Mean USD per run, for the cost row. */
  meanUsd?: number;
  /** Median run time, for the time row. */
  medianMs?: number;
}

export interface SignificanceOptions {
  /** Fixed by default so two reads of the same input are byte-identical. */
  seed?: number;
  resamples?: number;
  /**
   * Both sides carry billed cost (`costSource: billed`). Otherwise the cost row
   * says "not compared", the same rule `--compare` uses for its cost axis.
   */
  costComparable?: boolean;
}

/**
 * A relative change on a cost or time axis, with the same paired case-level
 * bootstrap as the pass rows. The statistic is a ratio minus 1: total cost
 * (sum of per-case mean USD) or the median of the per-case median times.
 */
export interface AxisSignificance {
  axis: "cost" | "time";
  before?: number;
  after?: number;
  /** after / before - 1 */
  change?: number;
  lower?: number;
  upper?: number;
  significant?: boolean;
  /** Set when the axis was not compared, with the reason. */
  notCompared?: string;
}

export type SignificanceMetric = "passAllK" | "passRate";

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
  /** Set when the input had no `passRate` and `passAllK` was used instead. */
  fallbackFrom?: "passAllK";
}

export interface CaseFlip {
  id: string;
  passAllKChange: number;
  passRateChange?: number;
}

export interface SkippedCase {
  id: string;
  side: "before" | "after";
  /** `invalid` means a score was missing where it was required or not finite. */
  reason: "missing" | "invalid";
}

export interface SignificanceResult {
  seed: number;
  resamples: number;
  /** Cases present on both sides that entered the resampling. */
  paired: number;
  skipped: SkippedCase[];
  warnings: string[];
  metrics: MetricSignificance[];
  /** Cost and time rows (#392 item 3). */
  axes: AxisSignificance[];
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
  const pairing = pairCases(indexCases(before), indexCases(after));
  const result: SignificanceResult = {
    seed,
    resamples,
    paired: pairing.paired.length,
    skipped: pairing.skipped,
    warnings: [...pairing.warnings],
    metrics: [],
    axes: [],
    flips: [],
  };
  if (pairing.paired.length === 0) {
    result.warnings.push("no paired cases: nothing to resample");
    return result;
  }
  const metrics = buildMetrics(pairing.paired, seed, resamples);
  result.metrics = metrics.rows;
  if (metrics.warning) result.warnings.push(metrics.warning);
  result.flips = buildFlips(pairing.paired);
  result.axes = [
    options.costComparable === false
      ? { axis: "cost", notCompared: "the cost source differs or is not billed on both sides" }
      : bootstrapAxis("cost", pairing.paired, (entry) => entry.meanUsd, sum, seed, resamples),
    bootstrapAxis("time", pairing.paired, (entry) => entry.medianMs, medianOf, seed, resamples),
  ];
  return result;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Paired bootstrap of `aggregate(after) / aggregate(before) - 1` over cases that carry the field on both sides. */
function bootstrapAxis(
  axis: "cost" | "time",
  paired: readonly PairedCase[],
  pick: (entry: SignificanceCase) => number | undefined,
  aggregate: (values: readonly number[]) => number,
  seed: number,
  resamples: number,
): AxisSignificance {
  const usable = paired.filter(({ before: left, after: right }) => isScore(pick(left)) && isScore(pick(right)));
  if (usable.length === 0) return { axis, notCompared: `no paired case carries ${axis === "cost" ? "meanUsd" : "medianMs"}` };
  const before = usable.map(({ before: entry }) => pick(entry) as number);
  const after = usable.map(({ after: entry }) => pick(entry) as number);
  const base = aggregate(before);
  if (!(base > 0)) return { axis, notCompared: `the baseline ${axis} is zero` };
  const random = mulberry32(seed);
  const changes: number[] = [];
  for (let draw = 0; draw < resamples; draw += 1) {
    const left: number[] = [];
    const right: number[] = [];
    for (let pickIndex = 0; pickIndex < usable.length; pickIndex += 1) {
      const index = Math.floor(random() * usable.length);
      left.push(before[index]);
      right.push(after[index]);
    }
    const leftValue = aggregate(left);
    if (leftValue > 0) changes.push(aggregate(right) / leftValue - 1);
  }
  changes.sort((leftValue, rightValue) => leftValue - rightValue);
  const lower = changes[Math.floor(0.025 * (changes.length - 1))];
  const upper = changes[Math.ceil(0.975 * (changes.length - 1))];
  return {
    axis,
    before: base,
    after: aggregate(after),
    change: aggregate(after) / base - 1,
    lower,
    upper,
    significant: lower > 0 || upper < 0,
  };
}

interface CaseIndex {
  valid: Map<string, SignificanceCase>;
  invalid: Map<string, string>;
}

interface CasePairing {
  paired: PairedCase[];
  skipped: SkippedCase[];
  warnings: string[];
}

/** Split one side into usable cases and cases with a named bad field. */
function indexCases(input: readonly SignificanceCase[]): CaseIndex {
  const valid = new Map<string, SignificanceCase>();
  const invalid = new Map<string, string>();
  for (const entry of input) {
    const field = invalidField(entry);
    if (field) invalid.set(entry.id, field);
    else valid.set(entry.id, entry);
  }
  return { valid, invalid };
}

/** Pair by id across both sides; skipped entries keep the sorted id order. */
function pairCases(before: CaseIndex, after: CaseIndex): CasePairing {
  const ids = [
    ...new Set([
      ...before.valid.keys(),
      ...after.valid.keys(),
      ...before.invalid.keys(),
      ...after.invalid.keys(),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const paired: PairedCase[] = [];
  const skipped: SkippedCase[] = [];
  for (const id of ids) {
    const left = before.valid.get(id);
    const right = after.valid.get(id);
    if (left && right) paired.push({ id, before: left, after: right });
    else skipped.push(skipEntry(id, before, after));
  }
  return {
    paired,
    skipped,
    warnings: skipped.map((entry) => skipWarning(entry, before, after)),
  };
}

function skipEntry(id: string, before: CaseIndex, after: CaseIndex): SkippedCase {
  if (!before.valid.has(id)) {
    return { id, side: "before", reason: before.invalid.has(id) ? "invalid" : "missing" };
  }
  return { id, side: "after", reason: after.invalid.has(id) ? "invalid" : "missing" };
}

function skipWarning(entry: SkippedCase, before: CaseIndex, after: CaseIndex): string {
  const side = entry.side === "before" ? "baseline" : "candidate";
  if (entry.reason === "invalid") {
    const index = entry.side === "before" ? before : after;
    return `skipped ${entry.id}: invalid ${index.invalid.get(entry.id) ?? "score"} in ${side}`;
  }
  return `skipped ${entry.id}: missing in ${side}`;
}

/**
 * The two metric rows. When any paired case lacks a `passRate`, the pass@1 row
 * repeats the passAllK numbers and carries the fallback marker.
 */
function buildMetrics(
  paired: readonly PairedCase[],
  seed: number,
  resamples: number,
): { rows: MetricSignificance[]; warning?: string } {
  const hasPassRate = paired.every(
    ({ before: left, after: right }) => isScore(left.passRate) && isScore(right.passRate),
  );
  const beforePassAllK = paired.map(({ before: entry }) => entry.passAllK);
  const afterPassAllK = paired.map(({ after: entry }) => entry.passAllK);
  const rows = [bootstrapMetric("passAllK", beforePassAllK, afterPassAllK, seed, resamples)];
  if (hasPassRate) {
    rows.push(
      bootstrapMetric("passRate", passRates(paired, "before"), passRates(paired, "after"), seed, resamples),
    );
    return { rows };
  }
  rows.push({
    ...bootstrapMetric("passRate", beforePassAllK, afterPassAllK, seed, resamples),
    fallbackFrom: "passAllK",
  });
  return {
    rows,
    warning: "passRate is missing on at least one side; passAllK is used for both metrics",
  };
}

function passRates(paired: readonly PairedCase[], side: "before" | "after"): number[] {
  return paired.map((entry) => entry[side].passRate as number);
}

function buildFlips(paired: readonly PairedCase[]): CaseFlip[] {
  return paired
    .map(({ id, before: left, after: right }) => ({
      id,
      passAllKChange: right.passAllK - left.passAllK,
      passRateChange:
        isScore(left.passRate) && isScore(right.passRate)
          ? right.passRate - left.passRate
          : undefined,
    }))
    .filter((flip) => flip.passAllKChange !== 0 || (flip.passRateChange ?? 0) !== 0)
    .sort(
      (left, right) =>
        flipMagnitude(right) - flipMagnitude(left) || left.id.localeCompare(right.id),
    );
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

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isScore(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

/** The first score that cannot be used, or null when the case is valid. */
function invalidField(entry: SignificanceCase): string | null {
  const badPassAllK = !Number.isFinite(entry.passAllK);
  const badPassRate = entry.passRate !== undefined && !Number.isFinite(entry.passRate);
  if (badPassAllK && badPassRate) return "passAllK and passRate";
  if (badPassAllK) return "passAllK";
  if (badPassRate) return "passRate";
  return null;
}

function flipMagnitude(flip: CaseFlip): number {
  return Math.max(Math.abs(flip.passAllKChange), Math.abs(flip.passRateChange ?? 0));
}

export interface SignificanceLabels {
  before: string;
  after: string;
}

/** Shared read-only default; never hand a fresh mutable literal to every call. */
const DEFAULT_LABELS: SignificanceLabels = Object.freeze({ before: "Before", after: "After" });

/** Compact Markdown: the metric table, the excluded cases, warnings, and flips. */
export function formatSignificance(
  result: SignificanceResult,
  labels: SignificanceLabels = DEFAULT_LABELS,
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
    const name = metric.metric === "passAllK" ? "pass^K" : "pass@1";
    const label = metric.fallbackFrom ? `${name} (passAllK fallback)` : name;
    lines.push(
      `| ${label} | ${percent(metric.before)} | ${percent(metric.after)} | ${points(metric.difference)} | ${interval(metric.lower, metric.upper)} | ${verdict(metric)} |`,
    );
  }
  for (const axis of result.axes) lines.push(axisRow(axis));
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
      lines.push(`| ${flip.id} | ${signed(flip.passAllKChange, String)} | ${passRate} |`);
    }
  } else if (result.paired > 0) {
    lines.push("", "No case changed.");
  }
  return `${lines.join("\n")}\n`;
}

function axisRow(axis: AxisSignificance): string {
  const name = axis.axis === "cost" ? "total cost" : "median case time";
  if (axis.notCompared || axis.change === undefined) {
    return `| ${name} | - | - | - | - | not compared (${axis.notCompared ?? "no data"}) |`;
  }
  const value = (number: number) => (axis.axis === "cost" ? `$${number.toFixed(4)}` : `${(number / 1000).toFixed(1)}s`);
  const pct = (number: number) => trimmed((number * 100).toFixed(1));
  return `| ${name} | ${value(axis.before as number)} | ${value(axis.after as number)} | ${signed(axis.change, pct)}% | [${signed(axis.lower as number, pct)}, ${signed(axis.upper as number, pct)}]% | ${axis.significant ? "significant (CI excludes 0)" : "not significant (CI includes 0)"} |`;
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
