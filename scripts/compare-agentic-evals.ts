import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

type EvalCaseStatus = "pass" | "problem" | "skipped" | string;
type EvalSeverity = "error" | "warning" | string;

interface EvalFindingLike {
  severity?: EvalSeverity;
  area?: string;
  message?: string;
}

interface EvalCaseResultLike {
  id: string;
  type?: string;
  status?: EvalCaseStatus;
  findings?: EvalFindingLike[];
  metrics?: Record<string, unknown>;
}

interface EvalRunSummaryLike {
  runId?: string;
  suite?: {
    name?: string;
    description?: string;
  };
  results?: EvalCaseResultLike[];
}

export interface EvalMetricDelta {
  key: string;
  before: number;
  after: number;
  delta: number;
  direction: "higher-is-better" | "lower-is-better" | "neutral";
}

export interface EvalCaseComparison {
  id: string;
  type: string;
  baselineStatus: string;
  candidateStatus: string;
  baselineFindings: FindingCounts;
  candidateFindings: FindingCounts;
  findingDelta: FindingCounts;
  metrics: EvalMetricDelta[];
}

interface FindingCounts {
  errors: number;
  warnings: number;
  total: number;
}

export interface EvalComparisonSignal {
  severity: "regression" | "improvement";
  caseId: string;
  area: string;
  message: string;
}

export interface EvalRunComparison {
  generatedAt: string;
  baseline: { runId: string; suiteName: string };
  candidate: { runId: string; suiteName: string };
  totals: {
    baseline: FindingCounts;
    candidate: FindingCounts;
    delta: FindingCounts;
  };
  cases: EvalCaseComparison[];
  regressions: EvalComparisonSignal[];
  improvements: EvalComparisonSignal[];
}

interface CliArgs {
  baseline?: string;
  candidate?: string;
  out?: string;
  format: "markdown" | "json";
  failOnRegression: boolean;
}

if (isCliEntrypoint()) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  });
}

export function compareEvalSummaries(
  baseline: EvalRunSummaryLike,
  candidate: EvalRunSummaryLike,
  now: () => Date = () => new Date(),
): EvalRunComparison {
  const baselineById = resultsById(baseline.results ?? []);
  const candidateById = resultsById(candidate.results ?? []);
  const caseIds = [...new Set([...baselineById.keys(), ...candidateById.keys()])].sort((a, b) => a.localeCompare(b));
  const cases = caseIds.map((id) => compareCase(id, baselineById.get(id), candidateById.get(id)));
  const totals = {
    baseline: sumFindingCounts(cases.map((entry) => entry.baselineFindings)),
    candidate: sumFindingCounts(cases.map((entry) => entry.candidateFindings)),
    delta: sumFindingCounts(cases.map((entry) => entry.findingDelta)),
  };
  const signals = cases.flatMap(caseSignals);
  return {
    generatedAt: now().toISOString(),
    baseline: {
      runId: baseline.runId ?? "(unknown)",
      suiteName: baseline.suite?.name ?? "(unknown)",
    },
    candidate: {
      runId: candidate.runId ?? "(unknown)",
      suiteName: candidate.suite?.name ?? "(unknown)",
    },
    totals,
    cases,
    regressions: signals.filter((signal) => signal.severity === "regression"),
    improvements: signals.filter((signal) => signal.severity === "improvement"),
  };
}

export function formatEvalComparisonMarkdown(comparison: EvalRunComparison): string {
  const lines = [
    `# Agentic Eval Comparison`,
    "",
    `Generated: ${comparison.generatedAt}`,
    `Baseline: ${comparison.baseline.runId} (${comparison.baseline.suiteName})`,
    `Candidate: ${comparison.candidate.runId} (${comparison.candidate.suiteName})`,
    "",
    "## Finding Totals",
    markdownTable(
      ["Metric", "Baseline", "Candidate", "Delta"],
      [
        ["Errors", comparison.totals.baseline.errors, comparison.totals.candidate.errors, signed(comparison.totals.delta.errors)],
        [
          "Warnings",
          comparison.totals.baseline.warnings,
          comparison.totals.candidate.warnings,
          signed(comparison.totals.delta.warnings),
        ],
        ["Total", comparison.totals.baseline.total, comparison.totals.candidate.total, signed(comparison.totals.delta.total)],
      ],
    ),
    "",
    "## Cases",
    markdownTable(
      ["Case", "Status", "Errors", "Warnings", "Metric deltas"],
      comparison.cases.map((entry) => [
        entry.id,
        `${entry.baselineStatus} -> ${entry.candidateStatus}`,
        `${entry.baselineFindings.errors} -> ${entry.candidateFindings.errors} (${signed(entry.findingDelta.errors)})`,
        `${entry.baselineFindings.warnings} -> ${entry.candidateFindings.warnings} (${signed(entry.findingDelta.warnings)})`,
        summarizeMetricDeltas(entry.metrics),
      ]),
    ),
  ];

  appendSignals(lines, "Regressions", comparison.regressions);
  appendSignals(lines, "Improvements", comparison.improvements);
  appendMetricTables(lines, comparison.cases);
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.baseline || !args.candidate) {
    process.stderr.write(usageText());
    process.exit(1);
  }

  const baseline = JSON.parse(await readFile(args.baseline, "utf8")) as EvalRunSummaryLike;
  const candidate = JSON.parse(await readFile(args.candidate, "utf8")) as EvalRunSummaryLike;
  const comparison = compareEvalSummaries(baseline, candidate);
  const output = args.format === "json"
    ? `${JSON.stringify(comparison, null, 2)}\n`
    : formatEvalComparisonMarkdown(comparison);

  if (args.out) {
    await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await writeFile(args.out, output, "utf8");
    process.stdout.write(`Wrote eval comparison to ${args.out}\n`);
  } else {
    process.stdout.write(output);
  }

  if (args.failOnRegression && comparison.regressions.length > 0) process.exit(1);
}

function compareCase(id: string, baseline: EvalCaseResultLike | undefined, candidate: EvalCaseResultLike | undefined): EvalCaseComparison {
  const baselineFindings = findingCounts(baseline?.findings ?? []);
  const candidateFindings = findingCounts(candidate?.findings ?? []);
  return {
    id,
    type: candidate?.type ?? baseline?.type ?? "(missing)",
    baselineStatus: baseline?.status ?? "(missing)",
    candidateStatus: candidate?.status ?? "(missing)",
    baselineFindings,
    candidateFindings,
    findingDelta: diffFindingCounts(baselineFindings, candidateFindings),
    metrics: compareMetrics(extractNumericMetrics(baseline?.metrics), extractNumericMetrics(candidate?.metrics)),
  };
}

function resultsById(results: EvalCaseResultLike[]): Map<string, EvalCaseResultLike> {
  const byId = new Map<string, EvalCaseResultLike>();
  for (const result of results) {
    if (typeof result.id === "string") byId.set(result.id, result);
  }
  return byId;
}

function findingCounts(findings: EvalFindingLike[]): FindingCounts {
  return {
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
    total: findings.length,
  };
}

function diffFindingCounts(before: FindingCounts, after: FindingCounts): FindingCounts {
  return {
    errors: after.errors - before.errors,
    warnings: after.warnings - before.warnings,
    total: after.total - before.total,
  };
}

function sumFindingCounts(counts: FindingCounts[]): FindingCounts {
  return counts.reduce(
    (total, count) => ({
      errors: total.errors + count.errors,
      warnings: total.warnings + count.warnings,
      total: total.total + count.total,
    }),
    { errors: 0, warnings: 0, total: 0 },
  );
}

function extractNumericMetrics(metrics: Record<string, unknown> | undefined): Record<string, number> {
  const extracted: Record<string, number> = {};
  collectMetrics(metrics ?? {}, "", extracted);
  return extracted;
}

function collectMetrics(value: unknown, prefix: string, output: Record<string, number>): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (prefix) output[prefix] = value;
    return;
  }
  if (Array.isArray(value)) {
    if (prefix) output[`${prefix}.length`] = value.length;
    const countTotal = value.reduce((total, item) => {
      if (isRecord(item) && typeof item.count === "number" && Number.isFinite(item.count)) return total + item.count;
      return total;
    }, 0);
    if (prefix && countTotal > 0) output[`${prefix}.countTotal`] = countTotal;
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    collectMetrics(nested, prefix ? `${prefix}.${key}` : key, output);
  }
}

function compareMetrics(before: Record<string, number>, after: Record<string, number>): EvalMetricDelta[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) => a.localeCompare(b));
  return keys
    .map((key) => ({
      key,
      before: before[key] ?? 0,
      after: after[key] ?? 0,
      delta: (after[key] ?? 0) - (before[key] ?? 0),
      direction: metricDirection(key),
    }))
    .filter((entry) => entry.before !== entry.after);
}

function metricDirection(key: string): EvalMetricDelta["direction"] {
  if (key.includes("cacheHits")) return "higher-is-better";
  const lowerIsBetter = [
    "contextChars",
    "toolSchemaTokens",
    "maxUserMessageChars",
    "maxAssistantInput",
    "totalTokens",
    "toolErrors",
    "repeatedExternalPathActions",
    "duplicateToolStarts",
    "issueCount",
    "promptRecommendationCount",
  ];
  return lowerIsBetter.some((fragment) => key.includes(fragment)) ? "lower-is-better" : "neutral";
}

function caseSignals(entry: EvalCaseComparison): EvalComparisonSignal[] {
  const signals: EvalComparisonSignal[] = [];
  if (entry.baselineStatus === "pass" && entry.candidateStatus === "problem") {
    signals.push({
      severity: "regression",
      caseId: entry.id,
      area: "status",
      message: "Case changed from pass to problem.",
    });
  }
  if (entry.baselineStatus === "problem" && entry.candidateStatus === "pass") {
    signals.push({
      severity: "improvement",
      caseId: entry.id,
      area: "status",
      message: "Case changed from problem to pass.",
    });
  }
  if (entry.candidateStatus === "(missing)" && entry.baselineStatus !== "(missing)") {
    signals.push({
      severity: "regression",
      caseId: entry.id,
      area: "coverage",
      message: "Candidate run is missing a baseline case.",
    });
  }
  if (entry.baselineStatus === "(missing)" && entry.candidateStatus !== "(missing)") {
    signals.push({
      severity: "improvement",
      caseId: entry.id,
      area: "coverage",
      message: "Candidate run adds a case.",
    });
  }
  appendFindingSignals(signals, entry, "errors", "error finding");
  appendFindingSignals(signals, entry, "warnings", "warning finding");
  for (const metric of entry.metrics) {
    const severity = metricSignal(metric);
    if (!severity) continue;
    signals.push({
      severity,
      caseId: entry.id,
      area: "metric",
      message: `${metric.key}: ${metric.before} -> ${metric.after} (${signed(metric.delta)})`,
    });
  }
  return signals;
}

function appendFindingSignals(
  signals: EvalComparisonSignal[],
  entry: EvalCaseComparison,
  key: "errors" | "warnings",
  label: string,
): void {
  const delta = entry.findingDelta[key];
  if (delta > 0) {
    signals.push({
      severity: "regression",
      caseId: entry.id,
      area: "findings",
      message: `Candidate adds ${delta} ${label}(s).`,
    });
  }
  if (delta < 0) {
    signals.push({
      severity: "improvement",
      caseId: entry.id,
      area: "findings",
      message: `Candidate removes ${Math.abs(delta)} ${label}(s).`,
    });
  }
}

function metricSignal(metric: EvalMetricDelta): EvalComparisonSignal["severity"] | null {
  if (metric.direction === "neutral" || metric.delta === 0) return null;
  if (metric.direction === "lower-is-better") return metric.delta > 0 ? "regression" : "improvement";
  return metric.delta > 0 ? "improvement" : "regression";
}

function appendSignals(lines: string[], heading: string, signals: EvalComparisonSignal[]): void {
  lines.push("", `## ${heading}`, "");
  if (signals.length === 0) {
    lines.push("- none");
    return;
  }
  for (const signal of signals.slice(0, 20)) {
    lines.push(`- ${signal.caseId} [${signal.area}] ${signal.message}`);
  }
  if (signals.length > 20) lines.push(`- ... ${signals.length - 20} more`);
}

function appendMetricTables(lines: string[], cases: EvalCaseComparison[]): void {
  const changed = cases.filter((entry) => entry.metrics.length > 0);
  if (changed.length === 0) return;
  lines.push("", "## Metric Deltas");
  for (const entry of changed) {
    lines.push(
      "",
      `### ${entry.id}`,
      "",
      markdownTable(
        ["Metric", "Baseline", "Candidate", "Delta", "Direction"],
        entry.metrics
          .filter((metric) => metric.direction !== "neutral" || Math.abs(metric.delta) > 0)
          .slice(0, 20)
          .map((metric) => [metric.key, metric.before, metric.after, signed(metric.delta), metric.direction]),
      ),
    );
  }
}

function summarizeMetricDeltas(metrics: EvalMetricDelta[]): string {
  const meaningful = metrics.filter((metric) => metric.direction !== "neutral");
  if (meaningful.length === 0) return "none";
  return meaningful
    .slice(0, 3)
    .map((metric) => `${metric.key} ${signed(metric.delta)}`)
    .join(", ");
}

function markdownTable(headers: Array<string | number>, rows: Array<Array<string | number>>): string {
  return [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ].join("\n");
}

function markdownCell(value: string | number): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { format: "markdown", failOnRegression: false };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--out") {
      args.out = readValue(argv, ++index, raw);
      continue;
    }
    if (raw === "--format") {
      args.format = readFormat(readValue(argv, ++index, raw));
      continue;
    }
    if (raw === "--fail-on-regression") {
      args.failOnRegression = true;
      continue;
    }
    if (raw.startsWith("--")) throw new Error(`Unknown option: ${raw}`);
    positional.push(raw);
  }
  if (positional.length > 0) args.baseline = positional[0];
  if (positional.length > 1) args.candidate = positional[1];
  if (positional.length > 2) throw new Error(`Unexpected extra argument: ${positional[2]}`);
  return args;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}

function readFormat(value: string): CliArgs["format"] {
  if (value === "markdown" || value === "json") return value;
  throw new Error(`Unsupported format: ${value}`);
}

function usageText(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/compare-agentic-evals.ts <baseline-summary.json> <candidate-summary.json> [--format markdown|json] [--out path] [--fail-on-regression]",
    "",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return typeof entrypoint === "string" && import.meta.url === pathToFileURL(entrypoint).href;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
