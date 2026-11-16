/**
 * Compare two tool-use results: a baseline file or a `summary.json` on either
 * side. Pure and read-only. A flag is a warning for a person to read, not a
 * verdict, so the comparison never fails a command.
 */

import {
  formatCaseThinking,
  oneDecimal,
  percent,
  ratio,
  seconds,
  usd,
  whole,
  type CaseThinking,
} from "./tool-use-report";

/** A cost or time increase above this share of the baseline gets a flag. */
const REGRESSION_THRESHOLD = 0.2;

/**
 * For the Pareto verdict, a cost or time change smaller than this share of the
 * baseline counts as "same": one 75-run sample moves by a few percent.
 */
export const PARETO_NOISE_SHARE = 0.1;

/** Absolute floors, so a zero or tiny baseline does not turn any change into a verdict. */
const PARETO_NOISE_FLOOR: Record<"cost" | "time", number> = { cost: 1e-6, time: 100 };

/** Float slack: 0.0011 - 0.001 is a hair above 1e-4, and "exactly 10%" must read as same. */
const FLOAT_SLACK = 1e-12;

export type ParetoAxis = "correctness" | "cost" | "time";
export type ParetoVerdict = "dominates" | "dominated" | "trade-off" | "same" | "incomplete";

export interface ParetoResult {
  verdict: ParetoVerdict;
  better: ParetoAxis[];
  worse: ParetoAxis[];
  same: ParetoAxis[];
  missing: ParetoAxis[];
}

/**
 * Compare two runs on the three objectives together: correctness (pass^K,
 * higher is better), cost (mean USD per run), and time (median case time),
 * both lower is better. A candidate that is better on one axis and worse on
 * none dominates; better on one and worse on another is a trade-off that a
 * person must name. A pass^K gain alone is never "better" if it costs more.
 */
export function paretoCompare(baseline: unknown, candidate: unknown): ParetoResult {
  const before = overallOf(baseline);
  const after = overallOf(candidate);
  const result: ParetoResult = { verdict: "same", better: [], worse: [], same: [], missing: [] };
  const axes: Array<[ParetoAxis, string, "higher" | "lower"]> = [
    ["correctness", "passAllK", "higher"],
    ["cost", "meanUsd", "lower"],
    ["time", "medianCaseMs", "lower"],
  ];
  const costComparable = sameCostSource(baseline, candidate);
  for (const [axis, key, direction] of axes) {
    const left = numberValue(before[key]);
    const right = numberValue(after[key]);
    // A price-table cost and a billed cost differ by up to ~45%; never rank one against the other.
    if (left === undefined || right === undefined || (axis === "cost" && !costComparable)) {
      result.missing.push(axis);
      continue;
    }
    // Correctness: any change counts; the significance section says if it is noise.
    const tolerance =
      axis === "correctness" ? 0 : Math.max(Math.abs(left) * PARETO_NOISE_SHARE, PARETO_NOISE_FLOOR[axis]);
    const gain = direction === "higher" ? right - left : left - right;
    if (Math.abs(gain) <= tolerance + FLOAT_SLACK) result.same.push(axis);
    else if (gain > 0) result.better.push(axis);
    else result.worse.push(axis);
  }
  if (result.missing.length > 0) result.verdict = "incomplete";
  else if (result.better.length > 0 && result.worse.length === 0) result.verdict = "dominates";
  else if (result.worse.length > 0 && result.better.length === 0) result.verdict = "dominated";
  else if (result.better.length > 0) result.verdict = "trade-off";
  return result;
}

export function formatPareto(result: ParetoResult): string {
  const parts = (["better", "worse", "same", "missing"] as const)
    .filter((key) => result[key].length > 0)
    .map((key) => `${key}: ${result[key].join(", ")}`);
  const meaning: Record<ParetoVerdict, string> = {
    dominates: "the candidate is at least as good on all three axes and better on one",
    dominated: "the candidate is worse on at least one axis and better on none",
    "trade-off": "the candidate trades one axis for another; name the trade before you accept it",
    same: "no axis moved beyond noise",
    incomplete: "an axis is missing on one side; this is no verdict",
  };
  return `Pareto (correctness, cost, time): **${result.verdict}** (${parts.join("; ")}). ${meaning[result.verdict]}.`;
}

type Format = (value: number) => string;

interface CaseMetrics {
  passRate?: number;
  passAllK?: number;
  partialScore?: number;
  meanTokens?: number;
  meanUsd?: number;
  medianMs?: number;
  thinking: Partial<CaseThinking>;
}

const CASE_COLUMNS: ReadonlyArray<[label: string, key: Exclude<keyof CaseMetrics, "thinking">, format: Format]> = [
  ["Pass rate", "passRate", percent],
  ["pass^K", "passAllK", whole],
  ["Partial score", "partialScore", ratio],
  ["Median s", "medianMs", seconds],
  ["Mean tokens", "meanTokens", whole],
  ["Mean USD", "meanUsd", usd],
];

const OVERALL_ROWS: ReadonlyArray<[label: string, key: string, format: Format]> = [
  ["pass^K", "passAllK", percent],
  ["mean pass@1", "meanPassAt1", percent],
  ["partial score", "partialScore", ratio],
  ["total cost", "totalUsd", usd],
  ["mean cost", "meanUsd", usd],
  ["mean tokens", "meanTokens", whole],
  ["mean model calls", "meanModelCalls", oneDecimal],
  ["mean tool calls", "meanToolCalls", oneDecimal],
  ["median time", "medianCaseMs", seconds],
];

export function formatComparison(baseline: unknown, candidate: unknown): string {
  const before = caseMetrics(baseline);
  const after = caseMetrics(candidate);
  const costComparable = sameCostSource(baseline, candidate);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right));
  const overallBefore = isRecord(baseline) && isRecord(baseline.overall) ? baseline.overall : {};
  const overallAfter = isRecord(candidate) && isRecord(candidate.overall) ? candidate.overall : {};

  const lines = [
    "# Tool-use eval comparison",
    "",
    runIdentity("Baseline", baseline),
    runIdentity("Candidate", candidate),
    "",
    ...identityWarnings(baseline, candidate),
    "## Overall",
    "",
  ];
  lines.push("| Metric | Baseline | Candidate | Change |", "|---|---|---|---|");
  for (const [label, key, format] of OVERALL_ROWS) {
    const left = numberValue(overallBefore[key]);
    const right = numberValue(overallAfter[key]);
    lines.push(`| ${label} | ${cell(left, format)} | ${cell(right, format)} | ${change(left, right, format)} |`);
  }
  lines.push("", formatPareto(paretoCompare(baseline, candidate)));
  lines.push(
    "",
    "## Cases",
    "",
    `| Case | Thinking | ${CASE_COLUMNS.map(([label]) => label).join(" | ")} | Flags |`,
    `|---|---|${CASE_COLUMNS.map(() => "---|").join("")}---|`,
  );
  for (const id of ids) {
    const left = before.get(id);
    const right = after.get(id);
    const cells = CASE_COLUMNS.map(([, key, format]) => delta(left?.[key], right?.[key], format));
    lines.push(
      `| ${id} | ${compareThinking(left, right)} | ${cells.join(" | ")} | ${caseFlags(left, right, costComparable)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Both sides are `billed` or both are `table`. `mixed`, `none`, and an old file with no field are not comparable. */
function sameCostSource(baseline: unknown, candidate: unknown): boolean {
  const left = costSourceName(baseline);
  return (left === "billed" || left === "table") && left === costSourceName(candidate);
}

function costSourceName(input: unknown): string | undefined {
  return isRecord(input) && typeof input.costSource === "string" ? input.costSource : undefined;
}

/** One line that names the suite, model, and reasoning level of a summary or baseline. */
function runIdentity(label: string, input: unknown): string {
  if (!isRecord(input)) return `- ${label}: (missing)`;
  const level = typeof input.thinkingLevel === "string" ? input.thinkingLevel : "(not recorded)";
  const source = typeof input.thinkingLevelSource === "string" ? ` (${input.thinkingLevelSource})` : "";
  const cost = costSourceName(input) ?? "unknown";
  return `- ${label}: ${suiteName(input) ?? "(suite?)"}, ${modelName(input) ?? "(model?)"}, thinking ${level}${source}, cost ${cost}`;
}

function compareThinking(before: CaseMetrics | undefined, after: CaseMetrics | undefined): string {
  const left = before ? formatCaseThinking(before.thinking) : "(missing)";
  const right = after ? formatCaseThinking(after.thinking) : "(missing)";
  return left === right ? left : `${left} -> ${right}`;
}

/** Numbers from two suites or two models are not a before/after pair. Say so. */
function identityWarnings(baseline: unknown, candidate: unknown): string[] {
  const warnings: string[] = [];
  for (const [label, read] of [
    ["suite", suiteName],
    ["model", modelName],
  ] as const) {
    const left = read(baseline);
    const right = read(candidate);
    if (left && right && left !== right) {
      warnings.push(`> Warning: the ${label} differs (baseline \`${left}\`, candidate \`${right}\`).`);
    }
  }
  if (!sameCostSource(baseline, candidate)) {
    warnings.push(
      `> Warning: the cost source differs or is unknown (baseline \`${costSourceName(baseline) ?? "unknown"}\`, candidate \`${costSourceName(candidate) ?? "unknown"}\`); the cost axis is not compared.`,
    );
  }
  return warnings.length > 0 ? [...warnings, ""] : [];
}

/** A baseline stores the suite name as a string; a summary stores `{ name }`. */
function suiteName(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (typeof input.suite === "string") return input.suite;
  return isRecord(input.suite) && typeof input.suite.name === "string" ? input.suite.name : undefined;
}

function modelName(input: unknown): string | undefined {
  return isRecord(input) && typeof input.model === "string" ? input.model : undefined;
}

function caseFlags(
  before: CaseMetrics | undefined,
  after: CaseMetrics | undefined,
  costComparable: boolean,
): string {
  if (!before) return "new case";
  if (!after) return "removed case";
  const flags: string[] = [];
  const cost = growth(before.meanUsd, after.meanUsd);
  if (costComparable && cost > REGRESSION_THRESHOLD) flags.push(`cost +${Math.round(cost * 100)}%`);
  const time = growth(before.medianMs, after.medianMs);
  if (time > REGRESSION_THRESHOLD) flags.push(`time +${Math.round(time * 100)}%`);
  if (before.passRate !== undefined && after.passRate !== undefined && after.passRate < before.passRate) {
    flags.push(`pass -${Math.round((before.passRate - after.passRate) * 100)}`);
  }
  return flags.length > 0 ? flags.join("; ") : "-";
}

/** Relative increase over a positive baseline; 0 when it cannot be computed. */
function growth(before: number | undefined, after: number | undefined): number {
  if (before === undefined || after === undefined || before <= 0) return 0;
  return (after - before) / before;
}

function cell(value: number | undefined, format: Format): string {
  return value === undefined ? "(missing)" : format(value);
}

function change(before: number | undefined, after: number | undefined, format: Format): string {
  if (before === undefined || after === undefined) return "(missing)";
  const difference = after - before;
  if (difference === 0) return "0";
  return `${difference > 0 ? "+" : "-"}${format(Math.abs(difference))}`;
}

/** `before -> after (change)`. A side with no value reads `(missing)`, never 0. */
function delta(before: number | undefined, after: number | undefined, format: Format): string {
  if (before === undefined && after === undefined) return "(missing)";
  if (before === undefined || after === undefined) return `${cell(before, format)} -> ${cell(after, format)}`;
  return `${format(before)} -> ${format(after)} (${change(before, after, format)})`;
}

function caseMetrics(input: unknown): Map<string, CaseMetrics> {
  const output = new Map<string, CaseMetrics>();
  if (!isRecord(input) || !Array.isArray(input.cases)) return output;
  for (const entry of input.cases) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const metrics: CaseMetrics = {
      thinking: {
        thinkingLevel: typeof entry.thinkingLevel === "string" ? (entry.thinkingLevel as CaseThinking["thinkingLevel"]) : undefined,
        observedThinkingLevels: Array.isArray(entry.observedThinkingLevels)
          ? entry.observedThinkingLevels.filter((level): level is string => typeof level === "string")
          : undefined,
        thinkingLevelMismatches: numberValue(entry.thinkingLevelMismatches),
      },
    };
    for (const [, key] of CASE_COLUMNS) metrics[key] = numberValue(entry[key]);
    output.set(entry.id, metrics);
  }
  return output;
}

function overallOf(input: unknown): Record<string, unknown> {
  return isRecord(input) && isRecord(input.overall) ? input.overall : {};
}

function numberValue(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input);
}
