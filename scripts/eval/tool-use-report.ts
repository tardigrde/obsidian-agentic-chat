/**
 * Turn run records into the tool-use summary, report, and baseline.
 *
 * Pure: the runner does the reading and writing. Every function here takes
 * data and returns data or text, so the unit tests cover it without a process.
 */

import {
  BudgetTracker,
  costUsd,
  gradeRun,
  summarizeCase,
  summarizeOverall,
  type CaseSummary,
  type OverallSummary,
  type RunPricing,
  type RunStatus,
  type RunUsage,
  type ThinkingLevelSource,
  type ToolUseBudgetCaps,
  type ToolUseCase,
  type ToolUseCheckResult,
  type ToolUseThinkingLevel,
} from "./tool-use-core";
import { needsFixture, type PlannedRun, type RunRecord, type ToolUsePlan } from "./tool-use-plan";

export const TOOL_USE_SUMMARY_VERSION = 1;

export interface CaseRunEntry {
  run: number;
  status: RunStatus;
  ms: number;
  usage: RunUsage;
  modelCalls: number;
  toolCalls: number;
  /** Share of checks that passed; a run with no checks scores 0. */
  partialScore: number;
  usd: number;
  checks: ToolUseCheckResult[];
  /** Level the session recorded. Reporting only: a provider clamp must not fail a run. */
  observedThinkingLevel?: string;
  /** Why the run is an `error` or was skipped. */
  error?: string;
}

/** Thinking fields every case row carries in a summary and a baseline. */
export interface CaseThinking {
  /** The level this case requested. */
  thinkingLevel: ToolUseThinkingLevel;
  /** Distinct observed levels, sorted. Empty when the session had no entry. */
  observedThinkingLevels: string[];
  /** Runs whose observed level differs from the requested one. */
  thinkingLevelMismatches: number;
}

export interface CaseSummaryWithRuns extends CaseSummary, CaseThinking {
  id: string;
  runResults: CaseRunEntry[];
}

export interface ToolUseSummary {
  version: typeof TOOL_USE_SUMMARY_VERSION;
  runId: string;
  suite: ToolUsePlan["suite"];
  model: string;
  thinkingLevel: ToolUseThinkingLevel;
  thinkingLevelSource: ThinkingLevelSource;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  prices: RunPricing;
  budget: {
    caps: ToolUseBudgetCaps;
    used: { usd: number; modelCalls: number; tokens: number };
    exceeded: string | null;
  };
  overall: OverallSummary;
  cases: CaseSummaryWithRuns[];
}

/** The committed per-suite reference numbers that `--compare` reads. */
export interface ToolUseBaseline {
  version: typeof TOOL_USE_SUMMARY_VERSION;
  suite: string;
  model: string;
  thinkingLevel: ToolUseThinkingLevel;
  thinkingLevelSource: ThinkingLevelSource;
  prices: RunPricing;
  date: string;
  gitHead: string;
  overall: OverallSummary;
  cases: Array<
    { id: string } & CaseThinking & Pick<
      CaseSummary,
      | "passRate"
      | "passAllK"
      | "partialScore"
      | "meanTokens"
      | "meanUsd"
      | "meanModelCalls"
      | "meanToolCalls"
      | "medianMs"
      | "overBudgetRuns"
    >
  >;
}

/**
 * Grade one run record. A record that carries a harness error is an `error`,
 * whatever its checks say: an observation the harness could not finish is not
 * evidence about the model.
 */
export function gradeRecord(evalCase: ToolUseCase, record: RunRecord, prices: RunPricing): CaseRunEntry {
  if (record.skippedBudget) {
    return {
      run: record.run,
      status: "skipped-budget",
      ms: 0,
      usage: {},
      modelCalls: 0,
      toolCalls: 0,
      partialScore: 0,
      usd: 0,
      checks: [],
      error: record.skippedBudget,
    };
  }
  const grade = gradeRun(evalCase, record.observed);
  return {
    run: record.run,
    status: record.error ? "error" : grade.ok ? "pass" : "fail",
    ms: record.ms,
    usage: record.usage,
    modelCalls: record.modelCalls,
    toolCalls: record.observed.toolCalls.length,
    partialScore: grade.score,
    usd: costUsd(record.usage, prices),
    checks: grade.checks,
    ...(record.observedThinkingLevel ? { observedThinkingLevel: record.observedThinkingLevel } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

/** A planned run with no usable record: the spec died before it wrote one. */
export function missingRunEntry(planned: PlannedRun, reason: string): CaseRunEntry {
  return {
    run: planned.run,
    status: "error",
    ms: 0,
    usage: {},
    modelCalls: 0,
    toolCalls: 0,
    partialScore: 0,
    usd: 0,
    checks: [],
    error: reason,
  };
}

export function buildSummary(
  plan: ToolUsePlan,
  entriesByCase: ReadonlyMap<string, CaseRunEntry[]>,
  timing: { startedAt: Date; finishedAt: Date },
): ToolUseSummary {
  const cases: CaseSummaryWithRuns[] = plan.cases.map((evalCase) => {
    const runResults = entriesByCase.get(evalCase.id) ?? [];
    const level = evalCase.thinkingLevel ?? plan.thinkingLevel;
    return {
      id: evalCase.id,
      thinkingLevel: level,
      observedThinkingLevels: observedLevels(runResults),
      thinkingLevelMismatches: runResults.filter(
        (run) => run.observedThinkingLevel !== undefined && run.observedThinkingLevel !== level,
      ).length,
      ...summarizeCase(runResults, { maxToolCalls: evalCase.expected?.maxToolCalls }),
      runResults,
    };
  });
  const tracker = new BudgetTracker(plan.budget, plan.prices);
  for (const run of cases.flatMap((entry) => entry.runResults)) tracker.add(run);
  return {
    version: TOOL_USE_SUMMARY_VERSION,
    runId: plan.runId,
    suite: plan.suite,
    model: plan.model,
    thinkingLevel: plan.thinkingLevel,
    thinkingLevelSource: plan.thinkingLevelSource,
    startedAt: timing.startedAt.toISOString(),
    finishedAt: timing.finishedAt.toISOString(),
    durationMs: timing.finishedAt.getTime() - timing.startedAt.getTime(),
    prices: plan.prices,
    budget: { caps: plan.budget, used: tracker.totals(), exceeded: tracker.exceeded() },
    overall: summarizeOverall(cases),
    cases,
  };
}

export function toBaseline(summary: ToolUseSummary, stamp: { date: Date; gitHead: string }): ToolUseBaseline {
  return {
    version: TOOL_USE_SUMMARY_VERSION,
    suite: summary.suite.name,
    model: summary.model,
    thinkingLevel: summary.thinkingLevel,
    thinkingLevelSource: summary.thinkingLevelSource,
    prices: summary.prices,
    date: stamp.date.toISOString(),
    gitHead: stamp.gitHead,
    overall: summary.overall,
    cases: summary.cases.map((entry) => ({
      id: entry.id,
      thinkingLevel: entry.thinkingLevel,
      observedThinkingLevels: entry.observedThinkingLevels,
      thinkingLevelMismatches: entry.thinkingLevelMismatches,
      passRate: entry.passRate,
      passAllK: entry.passAllK,
      partialScore: entry.partialScore,
      meanTokens: entry.meanTokens,
      meanUsd: entry.meanUsd,
      meanModelCalls: entry.meanModelCalls,
      meanToolCalls: entry.meanToolCalls,
      medianMs: entry.medianMs,
      overBudgetRuns: entry.overBudgetRuns,
    })),
  };
}

/** Distinct observed levels for a case, sorted; missing observations are omitted. */
function observedLevels(runs: readonly CaseRunEntry[]): string[] {
  const levels = runs.map((run) => run.observedThinkingLevel).filter((level): level is string => !!level);
  return [...new Set(levels)].sort((left, right) => left.localeCompare(right));
}

/**
 * `low`, `low (observed low)`, or `low (observed high!; 1 mismatch(es))`. A
 * row with no requested level (an old baseline) reads `(missing)`.
 */
export function formatCaseThinking(entry: Partial<CaseThinking>): string {
  const requested = entry.thinkingLevel;
  if (!requested) return "(missing)";
  const observed = entry.observedThinkingLevels ?? [];
  if (observed.length === 0) return requested;
  const mismatches = entry.thinkingLevelMismatches ?? 0;
  const shown = observed.map((level) => (level === requested ? level : `${level}!`)).join(", ");
  return `${requested} (observed ${shown}${mismatches > 0 ? `; ${mismatches} mismatch(es)` : ""})`;
}

/** One baseline file per suite name, for example `core.json`. */
export function baselineFileName(suiteName: string): string {
  const slug = suiteName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`The suite name cannot be used as a baseline file name: ${JSON.stringify(suiteName)}`);
  return `${slug}.json`;
}

export const percent = (value: number): string => `${Math.round(value * 100)}%`;
export const whole = (value: number): string => String(Math.round(value));
export const usd = (value: number): string => `$${value.toFixed(6)}`;
export const ratio = (value: number): string => value.toFixed(3);
export const oneDecimal = (value: number): string => value.toFixed(1);
export const seconds = (value: number): string => `${(value / 1000).toFixed(1)}s`;

export function formatReport(summary: ToolUseSummary): string {
  const { overall, budget, prices } = summary;
  const lines = [
    `# Tool-use eval ${summary.runId}`,
    "",
    `Suite: ${summary.suite.name}`,
    `Model: ${summary.model}`,
    `Thinking level: ${summary.thinkingLevel} (${summary.thinkingLevelSource})`,
    `Prices (USD/token): input ${prices.input}, output ${prices.output}, cache-read ${prices.cacheRead}, cache-write ${prices.cacheWrite ?? 0}`,
    `Budget used: ${usd(budget.used.usd)}, ${budget.used.modelCalls} model call(s), ${budget.used.tokens} token(s)`,
    `Budget exceeded: ${budget.exceeded ?? "no"}`,
    "",
    "## Overall",
    "",
    `- Cases: ${overall.cases}; executed runs: ${overall.runs}`,
    `- pass^K: ${percent(overall.passAllK)}; mean pass@1: ${percent(overall.meanPassAt1)}; partial score: ${ratio(overall.partialScore)}`,
    `- Cost: ${usd(overall.totalUsd)} total, ${usd(overall.meanUsd)} per run`,
    `- Tokens: ${whole(overall.meanTokens)} per run`,
    `- Calls: ${oneDecimal(overall.meanModelCalls)} model, ${oneDecimal(overall.meanToolCalls)} tool per run`,
    `- Median case time: ${seconds(overall.medianCaseMs)}`,
    "",
    "| Case | Thinking | Pass rate | pass^K | Partial score | Errors | Mean model calls | Mean tool calls | Over budget | Median seconds | Mean seconds | Mean tokens | USD |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const entry of summary.cases) {
    lines.push(
      `| ${[
        entry.id,
        formatCaseThinking(entry),
        `${entry.passed}/${entry.executed}`,
        entry.passAllK,
        ratio(entry.partialScore),
        entry.errored,
        oneDecimal(entry.meanModelCalls),
        oneDecimal(entry.meanToolCalls),
        entry.overBudgetRuns,
        (entry.medianMs / 1000).toFixed(1),
        (entry.meanMs / 1000).toFixed(1),
        whole(entry.meanTokens),
        usd(entry.totalUsd),
      ].join(" | ")} |`,
    );
  }
  lines.push("", "## Per-run check failures", "");
  let failures = 0;
  for (const entry of summary.cases) {
    for (const run of entry.runResults) {
      const failed = run.checks.filter((check) => !check.ok);
      if (!run.error && failed.length === 0) continue;
      failures += 1;
      lines.push(`### ${entry.id} run ${run.run} (${run.status})`, "");
      if (run.error) lines.push(`- ${run.status === "skipped-budget" ? "skipped" : "run error"}: ${run.error}`);
      for (const check of failed) lines.push(`- ${check.type}: ${check.detail}`);
      lines.push("");
    }
  }
  if (failures === 0) lines.push("- none", "");
  return `${lines.join("\n")}\n`;
}

export function formatConsoleSummary(summary: ToolUseSummary, paths: { summary: string; report: string }): string {
  const { overall, budget } = summary;
  const errored = summary.cases.reduce((total, entry) => total + entry.errored, 0);
  const lines = [
    `Tool-use eval: ${summary.runId}`,
    `Thinking level: ${summary.thinkingLevel} (${summary.thinkingLevelSource})`,
    `Cases: ${summary.cases.length}; runs: ${overall.runs} executed; pass^K: ${percent(overall.passAllK)}; mean pass@1: ${percent(overall.meanPassAt1)}`,
  ];
  for (const entry of summary.cases) {
    lines.push(
      `- ${entry.id}: ${entry.passed}/${entry.executed} (thinking ${formatCaseThinking(entry)}, pass^K ${entry.passAllK}, partial ${entry.partialScore.toFixed(2)}, ${oneDecimal(entry.meanModelCalls)} model calls, ${oneDecimal(entry.meanToolCalls)} tool calls, ${seconds(entry.medianMs)} median, ${whole(entry.meanTokens)} tokens, ${usd(entry.totalUsd)})`,
    );
  }
  if (errored > 0) {
    lines.push(`Harness errors: ${errored} run(s) have no usable observation; see the report. They are not model failures.`);
  }
  lines.push(
    `Totals: ${usd(budget.used.usd)}, ${budget.used.modelCalls} model call(s), ${budget.used.tokens} token(s)`,
    `Overall: ${usd(overall.meanUsd)}/run, ${whole(overall.meanTokens)} tokens/run, ${oneDecimal(overall.meanModelCalls)} model calls/run, ${oneDecimal(overall.meanToolCalls)} tool calls/run, ${seconds(overall.medianCaseMs)} median case`,
    `Summary: ${paths.summary}`,
    `Report: ${paths.report}`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The dry run must not touch the network, so it cannot fetch prices. This
 * fixed assumption only makes the plan readable; a live run uses real prices.
 */
const DRY_RUN_ESTIMATE = {
  tokensPerRun: 15_000,
  inputShare: 0.8,
  inputUsdPerMillion: 0.05,
  outputUsdPerMillion: 0.2,
};

export interface DryRunPlan {
  suite: { name: string; path: string; model: string };
  cases: readonly ToolUseCase[];
  runsPerCase: number;
  budget: ToolUseBudgetCaps;
  turn: ToolUsePlan["turn"];
  outDir: string;
  thinking: { level: ToolUseThinkingLevel; source: ThinkingLevelSource };
}

export function formatDryRun(plan: DryRunPlan): string {
  const estimate = DRY_RUN_ESTIMATE;
  const runs = plan.cases.length * plan.runsPerCase;
  const usdPerRun =
    (estimate.tokensPerRun / 1_000_000) *
    (estimate.inputShare * estimate.inputUsdPerMillion + (1 - estimate.inputShare) * estimate.outputUsdPerMillion);
  const lines = [
    `Tool-use eval plan: ${plan.suite.name}`,
    `Suite: ${plan.suite.path}`,
    `Model: ${plan.suite.model}`,
    `Thinking level: ${plan.thinking.level} (${plan.thinking.source})`,
    `Cases: ${plan.cases.length}; ${plan.cases.length} case(s) x ${plan.runsPerCase} run(s) = ${runs} run(s)`,
    ...plan.cases.map((evalCase) => {
      const seedFiles = Object.keys(evalCase.seed.files).length;
      const fixtureNote = needsFixture([evalCase]) ? ", fixture server" : "";
      const level = evalCase.thinkingLevel ?? plan.thinking.level;
      return `- ${evalCase.id}: ${plan.runsPerCase} run(s), ${seedFiles} seed file(s)${fixtureNote}, thinking ${level}`;
    }),
    `Budget: maxUsd ${plan.budget.maxUsd}, maxModelCalls ${plan.budget.maxModelCalls}, maxTokens ${plan.budget.maxTokens}`,
    `Turn: timeoutMs ${plan.turn.timeoutMs}, maxTurnsPerPrompt ${plan.turn.maxTurnsPerPrompt}`,
    `Results: ${plan.outDir}`,
    "prices: not fetched (dry run)",
    `estimated cost: $${(runs * usdPerRun).toFixed(4)} (fixed assumption: ${estimate.tokensPerRun / 1000}k tokens/run, ` +
      `${percent(estimate.inputShare)} input at $${estimate.inputUsdPerMillion.toFixed(2)}/M and ` +
      `${percent(1 - estimate.inputShare)} output at $${estimate.outputUsdPerMillion.toFixed(2)}/M)`,
  ];
  return `${lines.join("\n")}\n`;
}
