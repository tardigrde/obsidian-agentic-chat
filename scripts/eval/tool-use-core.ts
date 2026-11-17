/**
 * Pure suite validation, grading, cost, and budget logic for the tool-use
 * evals. The runner and the WDIO spec both import this module, so it must not
 * load Obsidian at module scope. Frontmatter and links come from the
 * evaluator's real Obsidian metadata cache, so grading is synchronous and
 * parser-free.
 *
 * Related modules: `tool-use-plan.ts` (the runner/spec contract),
 * `tool-use-report.ts` (summary, report, baseline), `tool-use-compare.ts`.
 */

import { MUTATING_TOOLS } from "../../src/tools/tool-contracts";
import type { VaultSize } from "./vault-generator";

export const TOOL_USE_SUITE_VERSION = 1;
export const TOOL_USE_ALLOWED_MODELS = ["deepseek/deepseek-v4.1-flash"] as const;
const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export type ToolUseModel = (typeof TOOL_USE_ALLOWED_MODELS)[number];

/**
 * Reasoning levels an eval run may request. This mirrors the product's
 * `THINKING_LEVELS`; a unit test keeps the two lists equal. The default is
 * `low`, not `off`: with `off` this model gets no reasoning parameter and
 * OpenRouter then applies the provider default, which is `high`.
 */
export const TOOL_USE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ToolUseThinkingLevel = (typeof TOOL_USE_THINKING_LEVELS)[number];
export const DEFAULT_TOOL_USE_THINKING_LEVEL: ToolUseThinkingLevel = "low";
export type ThinkingLevelSource = "cli" | "env" | "suite" | "default";

export interface ThinkingLevelResolution {
  level: ToolUseThinkingLevel;
  source: ThinkingLevelSource;
}

export interface ToolUseBudgetCaps {
  maxUsd: number;
  maxModelCalls: number;
  maxTokens: number;
}

export interface ToolUseTurnLimits {
  timeoutMs: number;
  maxTurnsPerPrompt: number;
}

export interface ToolUseSeedVault {
  /** `S` has 50 notes, `M` has 500. The runner expands them into `seed.files`. */
  size: VaultSize;
  /** Non-negative PRNG seed. The same pair always gives the same bytes. */
  seed: number;
}

export interface ToolUseSeed {
  files: Record<string, string>;
  /** Vault-relative path to base64 file bytes. Whitespace in the value is ignored. */
  binaryFiles: Record<string, string>;
  /** Optional generated base vault. Case `files` win over the generated ones. */
  vault?: ToolUseSeedVault;
}

/** Reporting budgets. They never fail a check. */
export interface ToolUseExpected {
  maxToolCalls?: number;
}

export type ToolUseSettingValue = string | number | boolean;

export interface ToolUseCase {
  id: string;
  prompt: string;
  seed: ToolUseSeed;
  settings?: Record<string, ToolUseSettingValue>;
  /** Pins this case; wins over the run-level level. Omit to use the run level. */
  thinkingLevel?: ToolUseThinkingLevel;
  checks: ToolUseCheck[];
  expected?: ToolUseExpected;
}

export interface ToolUseSuite {
  version: typeof TOOL_USE_SUITE_VERSION;
  name: string;
  description?: string;
  model: string;
  runsPerCase: number;
  budget: ToolUseBudgetCaps;
  turn: ToolUseTurnLimits;
  /** Run-level reasoning level; CLI and env overrides win over it. */
  thinkingLevel?: ToolUseThinkingLevel;
  /**
   * Case ids of the quick before/after slice that `--smoke` runs, in run
   * order. The slice belongs to the suite, so the runner holds no case ids.
   */
  smoke?: string[];
  cases: ToolUseCase[];
}

export interface FileExistsCheck {
  type: "file_exists";
  path: string;
}

export interface FileAbsentCheck {
  type: "file_absent";
  path: string;
}

/** A literal substring, or a regular expression when `regex` is true. */
export interface TextMatcher {
  text: string;
  regex?: boolean;
  /** RegExp flags, for example "i". Defaults to "". */
  flags?: string;
}

export interface FileContainsCheck extends TextMatcher {
  type: "file_contains";
  path: string;
}

export interface FileNotContainsCheck extends TextMatcher {
  type: "file_not_contains";
  path: string;
}

export interface FrontmatterEqualsCheck {
  type: "frontmatter_equals";
  path: string;
  key: string;
  /**
   * Array modes:
   * - default (`exact` false): the property must contain every expected item,
   *   and extra items are allowed.
   * - `exact` true: the property must contain the same items in any order,
   *   with no missing and no extra items.
   * Scalar values always compare exactly.
   */
  value: string | number | boolean | string[];
  exact?: boolean;
}

export interface UnchangedCheck {
  type: "unchanged";
  path: string;
}

export interface LinkResolvesCheck {
  type: "link_resolves";
  /** The note that contains the link. */
  from: string;
  /** The file path that Obsidian resolved the link to. */
  to: string;
}

export interface NoUnresolvedLinksCheck {
  type: "no_unresolved_links";
  /** The note that must have no unresolved links. */
  path: string;
}

export interface ToolCalledCheck {
  type: "tool_called";
  name: string;
  min?: number;
}

export interface ToolNotCalledCheck {
  type: "tool_not_called";
  name: string;
}

export interface MaxToolCallsCheck {
  type: "max_tool_calls";
  max: number;
}

export interface AnswerContainsCheck extends TextMatcher {
  type: "answer_contains";
}

export interface AnswerNotContainsCheck extends TextMatcher {
  type: "answer_not_contains";
}

export interface NoToolErrorsCheck {
  type: "no_tool_errors";
}

/** Passes when at least one inner check passes (for example: ask_user OR a question in the answer). */
export interface AnyOfCheck {
  type: "any_of";
  checks: ToolUseCheck[];
}

export type ToolUseCheck =
  | FileExistsCheck
  | FileAbsentCheck
  | FileContainsCheck
  | FileNotContainsCheck
  | FrontmatterEqualsCheck
  | UnchangedCheck
  | LinkResolvesCheck
  | NoUnresolvedLinksCheck
  | ToolCalledCheck
  | ToolNotCalledCheck
  | MaxToolCallsCheck
  | AnswerContainsCheck
  | AnswerNotContainsCheck
  | NoToolErrorsCheck
  | AnyOfCheck;

export interface ObservedToolCall {
  name: string;
  isError?: boolean;
}

export interface ObservedRun {
  /** Markdown path to its text. */
  files: Record<string, string>;
  /**
   * Every file path in the vault, Markdown or not. `file_exists` and
   * `file_absent` read this list, so a moved PDF or CSV is gradeable. A record
   * without it falls back to the Markdown paths.
   */
  paths?: string[];
  frontmatter: Record<string, Record<string, unknown>>;
  /** Source note path to the file paths Obsidian resolved its links to. */
  links: Record<string, string[]>;
  /** Source note path to the link targets Obsidian could not resolve. */
  unresolvedLinks: Record<string, string[]>;
  toolCalls: ObservedToolCall[];
  answer: string;
}

export interface ToolUseCheckResult {
  type: ToolUseCheck["type"];
  ok: boolean;
  detail: string;
}

export interface GradeResult {
  ok: boolean;
  /** Share of checks that passed. */
  score: number;
  checks: ToolUseCheckResult[];
}

export interface RunUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  /**
   * USD that OpenRouter billed for the run (the sum of `usage.cost.total` on
   * messages with `totalFromProvider`). When set, it wins over the price table:
   * the table misses reasoning tokens and per-provider prices.
   */
  billedUsd?: number;
}

export interface RunPricing {
  /** USD per input token. */
  input: number;
  /** USD per output token. */
  output: number;
  /** USD per cache-read token. */
  cacheRead: number;
  /** USD per cache-write token. Missing or absent prices cost 0. */
  cacheWrite?: number;
}

/**
 * `fail` is the model's result: a check did not pass. `error` is the
 * harness's: the run did not produce a gradeable observation (a provider
 * error, a timeout, a missing result file). Both count as executed and as not
 * passed, but only `fail` says something about the model.
 */
export type RunStatus = "pass" | "fail" | "error" | "skipped-budget";

export interface CaseRunSummaryInput {
  status: RunStatus;
  usage: RunUsage;
  usd: number;
  ms: number;
  modelCalls?: number;
  toolCalls?: number;
  /** Share of checks that passed. A run with no checks scores 0, not 1. */
  partialScore?: number;
}

export interface CaseSummary {
  runs: number;
  executed: number;
  passed: number;
  /** Executed runs that ended in a harness error instead of a grade. */
  errored: number;
  skipped: number;
  passRate: number;
  /** 1 only when every executed run passed; the K is the run count. */
  passAllK: number;
  /** Mean share of checks that passed per executed run. */
  partialScore: number;
  meanTokens: number;
  maxTokens: number;
  totalUsd: number;
  meanUsd: number;
  /** Median run cost: robust to one long run that moves the mean (#392 item 3). */
  medianUsd: number;
  meanMs: number;
  /** Median wall-clock time of the executed runs. */
  medianMs: number;
  meanModelCalls: number;
  meanToolCalls: number;
  /** Runs whose tool-call count exceeds `expected.maxToolCalls`. */
  overBudgetRuns: number;
}

/** Top-level `overall` object in `summary.json`. */
export interface OverallSummary {
  cases: number;
  runs: number;
  /** Share of cases where every executed run passed. */
  passAllK: number;
  /** Mean of the per-case pass rates. */
  meanPassAt1: number;
  partialScore: number;
  totalUsd: number;
  meanUsd: number;
  meanTokens: number;
  meanModelCalls: number;
  meanToolCalls: number;
  /** Median of the per-case median run times. */
  medianCaseMs: number;
}

/**
 * Harness tools that mutate the vault but have no built-in contract. Keep this
 * list as small as possible: every other mutating tool must come from the
 * product's own `MUTATING_TOOLS` set.
 */
const EVAL_EXTRA_MUTATING = ["create_skill"] as const;

export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...MUTATING_TOOLS,
  ...EVAL_EXTRA_MUTATING,
]);

export function validateToolUseSuite(input: unknown): ToolUseSuite {
  const problems: string[] = [];
  const suite = asRecord(input, "suite", problems);
  if (!suite) throw validationError(problems);

  if (suite.version !== TOOL_USE_SUITE_VERSION) {
    problems.push(`suite.version must be ${TOOL_USE_SUITE_VERSION}.`);
  }

  const name = readString(suite.name, "suite.name", problems);
  const description = typeof suite.description === "string" ? suite.description : undefined;
  const model = readString(suite.model, "suite.model", problems);
  if (model && !TOOL_USE_ALLOWED_MODELS.includes(model as ToolUseModel)) {
    problems.push(
      `suite.model must be one of ${TOOL_USE_ALLOWED_MODELS.join(", ")}; got ${JSON.stringify(model)}.`,
    );
  }

  const runsPerCase = readNumber(suite.runsPerCase, "suite.runsPerCase", problems);
  if (runsPerCase !== undefined && (!Number.isInteger(runsPerCase) || runsPerCase < 1)) {
    problems.push("suite.runsPerCase must be an integer of at least 1.");
  }

  const budget = validateBudget(suite.budget, problems);
  const turn = validateTurn(suite.turn, problems);
  const thinkingLevel = readThinkingLevel(suite.thinkingLevel, "suite.thinkingLevel", problems);
  const casesRaw = asArray(suite.cases, "suite.cases", problems) ?? [];
  if (casesRaw.length === 0) problems.push("suite.cases must contain at least one case.");

  const cases = casesRaw.map((entry, index) => validateCase(entry, index, problems));
  const seen = new Set<string>();
  for (const evalCase of cases) {
    if (!evalCase) continue;
    if (seen.has(evalCase.id)) problems.push(`Duplicate tool-use case id: ${evalCase.id}.`);
    seen.add(evalCase.id);
  }
  const smoke = validateSmoke(suite.smoke, seen, problems);

  if (problems.length > 0) throw validationError(problems);

  return {
    version: TOOL_USE_SUITE_VERSION,
    name,
    description,
    model,
    runsPerCase: runsPerCase as number,
    budget: budget as ToolUseBudgetCaps,
    turn: turn as ToolUseTurnLimits,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(smoke ? { smoke } : {}),
    cases: cases as ToolUseCase[],
  };
}

/**
 * Check one level and name its source. The runner calls this for `--thinking-level`
 * and `AGENTIC_CHAT_THINKING_LEVEL`; suite validation collects the same problem
 * into its error list instead of throwing on the first one.
 */
export function parseThinkingLevel(value: unknown, source: string): ToolUseThinkingLevel {
  if (typeof value === "string" && (TOOL_USE_THINKING_LEVELS as readonly string[]).includes(value)) {
    return value as ToolUseThinkingLevel;
  }
  throw new Error(
    `${source} must be one of ${TOOL_USE_THINKING_LEVELS.join(", ")}; got ${JSON.stringify(value)}.`,
  );
}

/** CLI > env > suite field > the low default. */
export function resolveThinkingLevel(input: {
  cli?: string;
  env?: string;
  suite?: ToolUseThinkingLevel;
}): ThinkingLevelResolution {
  if (input.cli !== undefined) return { level: parseThinkingLevel(input.cli, "--thinking-level"), source: "cli" };
  if (input.env !== undefined) {
    return { level: parseThinkingLevel(input.env, "AGENTIC_CHAT_THINKING_LEVEL"), source: "env" };
  }
  if (input.suite !== undefined) return { level: input.suite, source: "suite" };
  return { level: DEFAULT_TOOL_USE_THINKING_LEVEL, source: "default" };
}

/** A case pin wins over the run-level level. */
export function effectiveThinkingLevel(
  evalCase: Pick<ToolUseCase, "thinkingLevel">,
  runLevel: ToolUseThinkingLevel,
): ToolUseThinkingLevel {
  return evalCase.thinkingLevel ?? runLevel;
}

function readThinkingLevel(
  input: unknown,
  at: string,
  problems: string[],
): ToolUseThinkingLevel | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "string" && (TOOL_USE_THINKING_LEVELS as readonly string[]).includes(input)) {
    return input as ToolUseThinkingLevel;
  }
  problems.push(
    `${at} must be one of ${TOOL_USE_THINKING_LEVELS.join(", ")}; got ${JSON.stringify(input)}.`,
  );
  return undefined;
}

export function gradeRun(caseDef: ToolUseCase, observed: ObservedRun): GradeResult {
  const checks = caseDef.checks.map((check) => evaluateCheck(check, caseDef, observed));
  const passed = checks.filter((check) => check.ok).length;
  return {
    ok: passed === checks.length,
    // A run with no checks scores 0, not 1: nothing was shown to work.
    score: checks.length > 0 ? passed / checks.length : 0,
    checks,
  };
}

export interface BaselineRefusalSummary {
  budget: { exceeded: string | null };
  cases: Array<{
    id: string;
    runResults: Array<{ status: RunStatus; error?: string }>;
  }>;
}

export interface BaselineRefusalSuite {
  runsPerCase: number;
  cases: Array<{ id: string }>;
}

/** Failing checks may enter a baseline; incomplete or errored runs may not. */
export function baselineRefusal(
  summary: BaselineRefusalSummary,
  plannedRunCount: number,
  suite: BaselineRefusalSuite,
): string | null {
  const runs = summary.cases.flatMap((entry) => entry.runResults);
  const skipped = runs.filter((run) => run.status === "skipped-budget");
  if (skipped.length > 0) {
    return `${skipped.length} run(s) were skipped by the budget; rerun with a higher cap.`;
  }
  const errored = runs.filter((run) => run.status === "error" || Boolean(run.error));
  if (errored.length > 0) {
    return `${errored.length} run(s) have a harness error; inspect the report.`;
  }
  if (runs.length !== plannedRunCount) {
    return `only ${runs.length} of ${plannedRunCount} planned run(s) executed.`;
  }
  if (summary.budget.exceeded) {
    return `the budget was exceeded (${summary.budget.exceeded}); rerun with a higher cap.`;
  }
  const covered = new Set(summary.cases.map((entry) => entry.id));
  const missing = suite.cases.filter((entry) => !covered.has(entry.id));
  if (missing.length > 0) {
    return `did not cover every suite case; missing ${missing.map((entry) => entry.id).join(", ")}.`;
  }
  const expected = suite.cases.length * suite.runsPerCase;
  if (plannedRunCount !== expected) {
    return `baseline needs every ${suite.cases.length} case(s) at runsPerCase ${suite.runsPerCase} = ${expected} run(s); planned ${plannedRunCount}.`;
  }
  return null;
}

export function summarizeCase(
  runs: CaseRunSummaryInput[],
  options: { maxToolCalls?: number } = {},
): CaseSummary {
  const skipped = runs.filter((run) => run.status === "skipped-budget").length;
  const executed = runs.filter((run) => run.status !== "skipped-budget");
  const passed = executed.filter((run) => run.status === "pass").length;
  const tokenCounts = executed.map((run) => tokenCount(run.usage));
  const totalUsd = executed.reduce((total, run) => total + finite(run.usd), 0);
  const mean = (value: number): number => (executed.length > 0 ? value / executed.length : 0);
  const maxToolCalls = options.maxToolCalls;

  return {
    runs: runs.length,
    executed: executed.length,
    passed,
    errored: executed.filter((run) => run.status === "error").length,
    skipped,
    passRate: executed.length > 0 ? passed / executed.length : 0,
    passAllK: executed.length > 0 && passed === executed.length ? 1 : 0,
    partialScore: mean(executed.reduce((total, run) => total + finite(run.partialScore), 0)),
    meanTokens: mean(tokenCounts.reduce((total, count) => total + count, 0)),
    maxTokens: tokenCounts.length > 0 ? Math.max(...tokenCounts) : 0,
    totalUsd,
    meanUsd: mean(totalUsd),
    medianUsd: median(executed.map((run) => finite(run.usd))),
    meanMs: mean(executed.reduce((total, run) => total + finite(run.ms), 0)),
    medianMs: median(executed.map((run) => finite(run.ms))),
    meanModelCalls: mean(executed.reduce((total, run) => total + finite(run.modelCalls), 0)),
    meanToolCalls: mean(executed.reduce((total, run) => total + finite(run.toolCalls), 0)),
    overBudgetRuns:
      maxToolCalls === undefined
        ? 0
        : executed.filter((run) => finite(run.toolCalls) > maxToolCalls).length,
  };
}

/**
 * Aggregate the per-case summaries into the `overall` object. Cost, tokens,
 * and calls are weighted by executed runs; the rate columns weigh each case
 * once, so a case with a skipped run does not skew the pass numbers.
 */
export function summarizeOverall(
  cases: Array<CaseSummary & { runResults: CaseRunSummaryInput[] }>,
): OverallSummary {
  const executedRuns = cases.flatMap((entry) =>
    entry.runResults.filter((run) => run.status !== "skipped-budget"),
  );
  const runs = executedRuns.length;
  const totalUsd = cases.reduce((total, entry) => total + finite(entry.totalUsd), 0);
  const meanOfRuns = (value: number): number => (runs > 0 ? value / runs : 0);
  const meanOfCases = (pick: (entry: CaseSummary) => number): number =>
    cases.length > 0 ? cases.reduce((total, entry) => total + finite(pick(entry)), 0) / cases.length : 0;
  const casesWithRuns = cases.filter((entry) => entry.executed > 0);

  return {
    cases: cases.length,
    runs,
    passAllK: meanOfCases((entry) => (entry.passAllK === 1 ? 1 : 0)),
    meanPassAt1: meanOfCases((entry) => entry.passRate),
    partialScore: meanOfCases((entry) => entry.partialScore),
    totalUsd,
    meanUsd: meanOfRuns(totalUsd),
    meanTokens: meanOfRuns(executedRuns.reduce((total, run) => total + tokenCount(run.usage), 0)),
    meanModelCalls: meanOfRuns(executedRuns.reduce((total, run) => total + finite(run.modelCalls), 0)),
    meanToolCalls: meanOfRuns(executedRuns.reduce((total, run) => total + finite(run.toolCalls), 0)),
    medianCaseMs: median(casesWithRuns.map((entry) => entry.medianMs)),
  };
}

export function costUsd(usage: RunUsage, pricing: RunPricing): number {
  if (finite(usage.billedUsd) > 0) return finite(usage.billedUsd);
  return (
    finite(usage.input) * finite(pricing.input) +
    finite(usage.output) * finite(pricing.output) +
    finite(usage.cacheRead) * finite(pricing.cacheRead) +
    finite(usage.cacheWrite) * finite(pricing.cacheWrite)
  );
}

export function tokenCount(usage: RunUsage): number {
  const total = finite(usage.totalTokens);
  if (total > 0) return total;
  return finite(usage.input) + finite(usage.output) + finite(usage.cacheRead) + finite(usage.cacheWrite);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export class BudgetTracker {
  private usd = 0;
  private modelCalls = 0;
  private tokens = 0;

  constructor(
    private readonly caps: ToolUseBudgetCaps,
    private readonly pricing: RunPricing,
  ) {}

  add(run: { usage: RunUsage; modelCalls?: number }): void {
    this.usd += costUsd(run.usage, this.pricing);
    this.modelCalls += finite(run.modelCalls);
    this.tokens += tokenCount(run.usage);
  }

  exceeded(): string | null {
    if (this.usd >= finite(this.caps.maxUsd)) {
      return `maxUsd (${formatUsd(this.usd)} spent, cap ${formatUsd(this.caps.maxUsd)})`;
    }
    if (this.modelCalls >= finite(this.caps.maxModelCalls)) {
      return `maxModelCalls (${this.modelCalls} calls, cap ${this.caps.maxModelCalls})`;
    }
    if (this.tokens >= finite(this.caps.maxTokens)) {
      return `maxTokens (${this.tokens} tokens, cap ${this.caps.maxTokens})`;
    }
    return null;
  }

  totals(): { usd: number; modelCalls: number; tokens: number } {
    return { usd: this.usd, modelCalls: this.modelCalls, tokens: this.tokens };
  }
}

function validateBudget(input: unknown, problems: string[]): ToolUseBudgetCaps | undefined {
  const budget = asRecord(input, "suite.budget", problems);
  if (!budget) return undefined;
  const maxUsd = readNonNegativeNumber(budget.maxUsd, "suite.budget.maxUsd", problems);
  const maxModelCalls = readNonNegativeNumber(budget.maxModelCalls, "suite.budget.maxModelCalls", problems);
  const maxTokens = readNonNegativeNumber(budget.maxTokens, "suite.budget.maxTokens", problems);
  return {
    maxUsd: maxUsd ?? 0,
    maxModelCalls: maxModelCalls ?? 0,
    maxTokens: maxTokens ?? 0,
  };
}

function validateTurn(input: unknown, problems: string[]): ToolUseTurnLimits | undefined {
  const turn = asRecord(input, "suite.turn", problems);
  if (!turn) return undefined;
  const timeoutMs = readNonNegativeNumber(turn.timeoutMs, "suite.turn.timeoutMs", problems);
  const maxTurnsPerPrompt = readNonNegativeNumber(turn.maxTurnsPerPrompt, "suite.turn.maxTurnsPerPrompt", problems);
  if (timeoutMs !== undefined && timeoutMs <= 0) problems.push("suite.turn.timeoutMs must be greater than 0.");
  if (maxTurnsPerPrompt !== undefined && (!Number.isInteger(maxTurnsPerPrompt) || maxTurnsPerPrompt < 1)) {
    problems.push("suite.turn.maxTurnsPerPrompt must be an integer of at least 1.");
  }
  return {
    timeoutMs: timeoutMs ?? 0,
    maxTurnsPerPrompt: maxTurnsPerPrompt ?? 1,
  };
}

function seedPathProblem(filePath: string): string | undefined {
  if (filePath.includes("\\")) {
    return "must be a vault-relative path (backslashes are not allowed).";
  }
  if (filePath.startsWith("/") || /^[A-Za-z]:\//.test(filePath)) {
    return "must be a vault-relative path (absolute paths are not allowed).";
  }
  if (filePath.split("/").some((segment) => segment === "..")) {
    return 'must be a vault-relative path (no ".." segments).';
  }
  if (filePath === ".obsidian" || filePath.startsWith(".obsidian/")) {
    return "must be a vault-relative path (not under .obsidian/).";
  }
  return undefined;
}

function validateCase(input: unknown, index: number, problems: string[]): ToolUseCase | undefined {
  const at = `suite.cases[${index}]`;
  const evalCase = asRecord(input, at, problems);
  if (!evalCase) return undefined;
  const id = readString(evalCase.id, `${at}.id`, problems);
  if (id && !CASE_ID_PATTERN.test(id)) {
    problems.push(`${at}.id must match ${CASE_ID_PATTERN.source} and must not be "." or "..".`);
  }
  const prompt = readString(evalCase.prompt, `${at}.prompt`, problems);

  const seedRecord = asRecord(evalCase.seed, `${at}.seed`, problems);
  const filesRecord = seedRecord ? asRecord(seedRecord.files, `${at}.seed.files`, problems) : undefined;
  const binaryRecord = seedRecord
    ? asRecord(seedRecord.binaryFiles ?? {}, `${at}.seed.binaryFiles`, problems)
    : undefined;
  const files: Record<string, string> = {};
  if (filesRecord) {
    for (const [filePath, content] of Object.entries(filesRecord)) {
      const pathProblem = seedPathProblem(filePath);
      if (pathProblem) {
        problems.push(`${at}.seed.files.${filePath} ${pathProblem}`);
        continue;
      }
      if (typeof content !== "string") {
        problems.push(`${at}.seed.files.${filePath} must be a string.`);
        continue;
      }
      files[filePath] = content;
    }
  }
  const binaryFiles: Record<string, string> = {};
  if (binaryRecord) {
    for (const [filePath, content] of Object.entries(binaryRecord)) {
      const pathProblem = seedPathProblem(filePath);
      if (pathProblem) {
        problems.push(`${at}.seed.binaryFiles.${filePath} ${pathProblem}`);
        continue;
      }
      if (typeof content !== "string") {
        problems.push(`${at}.seed.binaryFiles.${filePath} must be a base64 string.`);
        continue;
      }
      if (hasOwn(files, filePath)) {
        problems.push(`${at}.seed.binaryFiles.${filePath} is also a seed.files entry.`);
        continue;
      }
      binaryFiles[filePath] = content;
    }
  }

  const settings = validateSettings(evalCase.settings, `${at}.settings`, problems);
  const thinkingLevel = readThinkingLevel(evalCase.thinkingLevel, `${at}.thinkingLevel`, problems);
  const expected = validateExpected(evalCase.expected, `${at}.expected`, problems);
  const checksRaw = asArray(evalCase.checks, `${at}.checks`, problems) ?? [];
  if (checksRaw.length === 0) problems.push(`${at}.checks must contain at least one check.`);
  const checks = checksRaw
    .map((entry, checkIndex) => validateCheck(entry, `${at}.checks[${checkIndex}]`, problems))
    .filter((check): check is ToolUseCheck => check !== undefined);

  const vault = seedRecord
    ? validateSeedVault(seedRecord.vault, `${at}.seed.vault`, problems)
    : undefined;
  return {
    id,
    prompt,
    seed: {
      files,
      binaryFiles,
      ...(vault ? { vault } : {}),
    },
    settings,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    checks,
    ...(expected ? { expected } : {}),
  };
}

/** The smoke slice must name suite cases, each once. */
function validateSmoke(input: unknown, caseIds: ReadonlySet<string>, problems: string[]): string[] | undefined {
  if (input === undefined) return undefined;
  const entries = asArray(input, "suite.smoke", problems);
  if (!entries) return undefined;
  if (entries.length === 0) problems.push("suite.smoke must name at least one case when it is set.");
  const smoke: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const id = readString(entry, `suite.smoke[${index}]`, problems);
    if (!id) continue;
    if (!caseIds.has(id)) problems.push(`suite.smoke[${index}] is not a case id in this suite: ${id}.`);
    else if (smoke.includes(id)) problems.push(`suite.smoke[${index}] repeats the case id ${id}.`);
    else smoke.push(id);
  }
  return smoke;
}

function validateSeedVault(
  input: unknown,
  at: string,
  problems: string[],
): ToolUseSeedVault | undefined {
  if (input === undefined) return undefined;
  const record = asRecord(input, at, problems);
  if (!record) return undefined;
  const size = record.size === "S" || record.size === "M" || record.size === "L" ? record.size : undefined;
  if (size === undefined) problems.push(`${at}.size must be "S", "M", or "L".`);
  const seed =
    typeof record.seed === "number" && Number.isInteger(record.seed) && record.seed >= 0
      ? record.seed
      : undefined;
  if (seed === undefined) problems.push(`${at}.seed must be a non-negative integer.`);
  return { size: size ?? "S", seed: seed ?? 0 };
}

function validateExpected(
  input: unknown,
  at: string,
  problems: string[],
): ToolUseExpected | undefined {
  if (input === undefined) return undefined;
  const record = asRecord(input, at, problems);
  if (!record) return undefined;
  const maxToolCalls =
    typeof record.maxToolCalls === "number" &&
    Number.isInteger(record.maxToolCalls) &&
    record.maxToolCalls > 0
      ? record.maxToolCalls
      : undefined;
  if (record.maxToolCalls !== undefined && maxToolCalls === undefined) {
    problems.push(`${at}.maxToolCalls must be a positive integer.`);
  }
  return { maxToolCalls };
}

function validateSettings(
  input: unknown,
  at: string,
  problems: string[],
): Record<string, ToolUseSettingValue> | undefined {
  if (input === undefined) return undefined;
  const record = asRecord(input, at, problems);
  if (!record) return undefined;
  const settings: Record<string, ToolUseSettingValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      problems.push(`${at}.${key} must be a string, number, or boolean.`);
      continue;
    }
    settings[key] = value;
  }
  return settings;
}

function validateCheck(input: unknown, at: string, problems: string[]): ToolUseCheck | undefined {
  const check = asRecord(input, at, problems);
  if (!check) return undefined;
  const type = readString(check.type, `${at}.type`, problems);
  if (!type) return undefined;

  switch (type) {
    case "file_exists":
    case "file_absent":
    case "unchanged":
    case "no_unresolved_links":
      return { type, path: readString(check.path, `${at}.path`, problems) };
    case "file_contains":
    case "file_not_contains":
      return {
        type,
        path: readString(check.path, `${at}.path`, problems),
        ...readTextMatcher(check, at, problems),
      };
    case "frontmatter_equals": {
      const value = check.value;
      if (!isFrontmatterValue(value)) {
        problems.push(`${at}.value must be a string, number, boolean, or string array.`);
        return undefined;
      }
      return {
        type,
        path: readString(check.path, `${at}.path`, problems),
        key: readString(check.key, `${at}.key`, problems),
        value,
        exact: readOptionalBoolean(check.exact, `${at}.exact`, problems),
      };
    }
    case "link_resolves":
      return {
        type,
        from: readString(check.from, `${at}.from`, problems),
        to: readString(check.to, `${at}.to`, problems),
      };
    case "tool_called": {
      const min = check.min === undefined ? undefined : readNumber(check.min, `${at}.min`, problems);
      if (min !== undefined && (!Number.isInteger(min) || min < 1)) {
        problems.push(`${at}.min must be an integer of at least 1.`);
      }
      return { type, name: readString(check.name, `${at}.name`, problems), min };
    }
    case "tool_not_called":
      return { type, name: readString(check.name, `${at}.name`, problems) };
    case "max_tool_calls": {
      const max = readNumber(check.max, `${at}.max`, problems);
      if (max !== undefined && (!Number.isInteger(max) || max < 0)) {
        problems.push(`${at}.max must be an integer of at least 0.`);
      }
      return { type, max: max ?? 0 };
    }
    case "answer_contains":
    case "answer_not_contains":
      return { type, ...readTextMatcher(check, at, problems) };
    case "no_tool_errors":
      return { type };
    case "any_of": {
      if (!Array.isArray(check.checks) || check.checks.length < 2) {
        problems.push(`${at}.checks must be an array of at least 2 checks.`);
        return undefined;
      }
      const inner = check.checks.map((entry, index) => validateCheck(entry, `${at}.checks[${index}]`, problems));
      if (inner.some((entry) => entry === undefined)) return undefined;
      return { type, checks: inner as ToolUseCheck[] };
    }
    default:
      problems.push(`Unknown check type at ${at}: ${type}.`);
      return undefined;
  }
}

function evaluateCheck(
  check: ToolUseCheck,
  caseDef: ToolUseCase,
  observed: ObservedRun,
): ToolUseCheckResult {
  switch (check.type) {
    case "file_exists": {
      const found = hasFile(observed, check.path);
      return result(check, found, found ? `found ${check.path}` : `missing ${check.path}`);
    }
    case "file_absent": {
      const found = hasFile(observed, check.path);
      return result(check, !found, found ? `unexpected file ${check.path}` : `absent ${check.path}`);
    }
    case "file_contains":
    case "file_not_contains": {
      const content = observed.files[check.path];
      if (content === undefined) {
        const ok = check.type === "file_not_contains";
        return result(check, ok, `missing ${check.path}`);
      }
      const matches = matchesText(content, check);
      const ok = check.type === "file_contains" ? matches : !matches;
      return result(
        check,
        ok,
        `${check.path} ${matches ? "contains" : "does not contain"} ${JSON.stringify(check.text)}`,
      );
    }
    case "frontmatter_equals": {
      const frontmatter = observed.frontmatter[check.path];
      if (!frontmatter) return result(check, false, `${check.path} has no frontmatter`);
      if (!hasOwn(frontmatter, check.key)) {
        return result(check, false, `${check.path} has no frontmatter key ${check.key}`);
      }
      const actual = frontmatter[check.key];
      if (Array.isArray(check.value)) {
        if (!Array.isArray(actual)) {
          return result(check, false, `${check.key} is not an array: ${JSON.stringify(actual)}`);
        }
        const actualItems = actual.map((item) => String(item));
        const missing = check.value.filter((item) => !actualItems.includes(item));
        if (check.exact === true) {
          const equal = sameStringItems(check.value, actualItems);
          return result(
            check,
            equal,
            equal
              ? `${check.key} equals ${JSON.stringify(check.value)}`
              : `${check.key} is not exactly ${JSON.stringify(check.value)}; actual ${JSON.stringify(actual)}`,
          );
        }
        return result(
          check,
          missing.length === 0,
          missing.length === 0
            ? `${check.key} contains ${JSON.stringify(check.value)}`
            : `${check.key} is missing ${JSON.stringify(missing)}; actual ${JSON.stringify(actual)}`,
        );
      }
      const ok = Object.is(actual, check.value);
      return result(check, ok, `${check.key} is ${JSON.stringify(actual)}, expected ${JSON.stringify(check.value)}`);
    }
    case "unchanged": {
      const seedContent = caseDef.seed.files[check.path];
      if (seedContent === undefined) return result(check, false, `${check.path} is not a text seed file`);
      const content = observed.files[check.path];
      const ok = content === seedContent;
      return result(check, ok, ok ? `${check.path} is unchanged` : `${check.path} changed`);
    }
    case "link_resolves": {
      const targets = observed.links[check.from] ?? [];
      const ok = targets.includes(check.to);
      return result(
        check,
        ok,
        ok
          ? `${check.from} resolves a link to ${check.to}`
          : `${check.from} does not resolve a link to ${check.to}; resolved ${JSON.stringify(targets)}`,
      );
    }
    case "no_unresolved_links": {
      const targets = observed.unresolvedLinks[check.path] ?? [];
      const ok = targets.length === 0;
      return result(
        check,
        ok,
        ok
          ? `${check.path} has no unresolved links`
          : `${check.path} has unresolved links: ${JSON.stringify(targets)}`,
      );
    }
    case "tool_called": {
      const count = matchingToolCalls(observed.toolCalls, check.name).length;
      const min = check.min ?? 1;
      return result(check, count >= min, `${check.name}: ${count} call(s), expected at least ${min}`);
    }
    case "tool_not_called": {
      const count = matchingToolCalls(observed.toolCalls, check.name).length;
      return result(check, count === 0, `${check.name}: ${count} call(s), expected none`);
    }
    case "max_tool_calls":
      return result(
        check,
        observed.toolCalls.length <= check.max,
        `${observed.toolCalls.length} tool call(s), limit ${check.max}`,
      );
    case "answer_contains":
    case "answer_not_contains": {
      const matches = matchesText(observed.answer, check);
      const ok = check.type === "answer_contains" ? matches : !matches;
      return result(check, ok, `answer ${matches ? "contains" : "does not contain"} ${JSON.stringify(check.text)}`);
    }
    case "any_of": {
      const inner = check.checks.map((entry) => evaluateCheck(entry, caseDef, observed));
      const ok = inner.some((entry) => entry.ok);
      return result(check, ok, inner.map((entry) => `${entry.ok ? "ok" : "no"}: ${entry.detail}`).join("; "));
    }
    case "no_tool_errors": {
      const errors = observed.toolCalls.filter((call) => call.isError === true);
      return result(
        check,
        errors.length === 0,
        errors.length === 0 ? "no tool errors" : `${errors.length} tool error(s): ${errors.map((call) => call.name).join(", ")}`,
      );
    }
  }
}

function result(check: ToolUseCheck, ok: boolean, detail: string): ToolUseCheckResult {
  return { type: check.type, ok, detail };
}

function matchingToolCalls(calls: ObservedToolCall[], name: string): ObservedToolCall[] {
  if (name === "*mutating*") return calls.filter((call) => MUTATING_TOOL_NAMES.has(call.name));
  return calls.filter((call) => call.name === name);
}

/** Compare string arrays as multisets: same items, in any order. */
function sameStringItems(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right));
  const sortedActual = [...actual].sort((left, right) => left.localeCompare(right));
  return sortedExpected.every((item, index) => item === sortedActual[index]);
}

/** `validateToolUseSuite` has already compiled every pattern, so this cannot throw for a suite case. */
function matchesText(text: string, matcher: TextMatcher): boolean {
  if (matcher.regex !== true) return text.includes(matcher.text);
  return new RegExp(matcher.text, matcher.flags ?? "").test(text);
}

function hasFile(observed: ObservedRun, path: string): boolean {
  return observed.paths ? observed.paths.includes(path) : hasOwn(observed.files, path);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function validationError(problems: string[]): Error {
  return new Error(`Invalid tool-use suite:\n- ${problems.join("\n- ")}`);
}

function asRecord(input: unknown, at: string, problems: string[]): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    problems.push(`${at} must be an object.`);
    return undefined;
  }
  return input as Record<string, unknown>;
}

function asArray(input: unknown, at: string, problems: string[]): unknown[] | undefined {
  if (!Array.isArray(input)) {
    problems.push(`${at} must be an array.`);
    return undefined;
  }
  return input;
}

function readString(input: unknown, at: string, problems: string[]): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    problems.push(`${at} must be a non-empty string.`);
    return "";
  }
  return input;
}

function readNumber(input: unknown, at: string, problems: string[]): number | undefined {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    problems.push(`${at} must be a finite number.`);
    return undefined;
  }
  return input;
}

function readNonNegativeNumber(input: unknown, at: string, problems: string[]): number | undefined {
  const value = readNumber(input, at, problems);
  if (value !== undefined && value < 0) {
    problems.push(`${at} must be at least 0.`);
    return undefined;
  }
  return value;
}

function readOptionalString(input: unknown, at: string, problems: string[]): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") {
    problems.push(`${at} must be a string.`);
    return undefined;
  }
  return input;
}

function readOptionalBoolean(input: unknown, at: string, problems: string[]): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "boolean") {
    problems.push(`${at} must be a boolean.`);
    return undefined;
  }
  return input;
}

function readTextMatcher(check: Record<string, unknown>, at: string, problems: string[]): TextMatcher {
  const text = readString(check.text, `${at}.text`, problems);
  const regex = readOptionalBoolean(check.regex, `${at}.regex`, problems);
  const flags = readOptionalString(check.flags, `${at}.flags`, problems);
  const compiles = (pattern: string, label: string, what: string): boolean => {
    try {
      new RegExp(pattern, flags ?? "");
      return true;
    } catch (error) {
      problems.push(`${at}.${label} is not ${what}: ${error instanceof Error ? error.message : String(error)}.`);
      return false;
    }
  };
  if (compiles("", "flags", "a valid regular expression flag set") && regex) {
    compiles(text, "text", "a valid regular expression");
  }
  return { text, regex, flags };
}

function isFrontmatterValue(value: unknown): value is string | number | boolean | string[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
