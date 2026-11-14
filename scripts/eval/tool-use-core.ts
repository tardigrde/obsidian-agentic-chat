/**
 * Pure grading, validation, cost, and budget logic for the `tool-use` eval
 * suite. The runner and the WDIO spec both import this module, so it must not
 * load Obsidian at module scope. Frontmatter comes from the evaluator's real
 * Obsidian metadata cache, so grading is synchronous and parser-free.
 */

import { MUTATING_TOOLS } from "../../src/tools/tool-contracts";

export const TOOL_USE_SUITE_VERSION = 1;
export const TOOL_USE_ALLOWED_MODELS = ["deepseek/deepseek-v4.1-flash"] as const;

export type ToolUseModel = (typeof TOOL_USE_ALLOWED_MODELS)[number];

export interface ToolUseBudgetCaps {
  maxUsd: number;
  maxModelCalls: number;
  maxTokens: number;
}

export interface ToolUseTurnLimits {
  timeoutMs: number;
  maxTurnsPerPrompt: number;
}

export interface ToolUseSeed {
  files: Record<string, string>;
}

export type ToolUseSettingValue = string | number | boolean;

export interface ToolUseCase {
  id: string;
  prompt: string;
  seed: ToolUseSeed;
  settings?: Record<string, ToolUseSettingValue>;
  checks: ToolUseCheck[];
}

export interface ToolUseSuite {
  version: typeof TOOL_USE_SUITE_VERSION;
  name: string;
  description?: string;
  model: string;
  runsPerCase: number;
  budget: ToolUseBudgetCaps;
  turn: ToolUseTurnLimits;
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

export interface FileContainsCheck {
  type: "file_contains";
  path: string;
  text: string;
  regex?: boolean;
}

export interface FileNotContainsCheck {
  type: "file_not_contains";
  path: string;
  text: string;
  regex?: boolean;
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

export interface AnswerContainsCheck {
  type: "answer_contains";
  text: string;
  regex?: boolean;
}

export interface AnswerNotContainsCheck {
  type: "answer_not_contains";
  text: string;
  regex?: boolean;
}

export interface NoToolErrorsCheck {
  type: "no_tool_errors";
}

export type ToolUseCheck =
  | FileExistsCheck
  | FileAbsentCheck
  | FileContainsCheck
  | FileNotContainsCheck
  | FrontmatterEqualsCheck
  | UnchangedCheck
  | ToolCalledCheck
  | ToolNotCalledCheck
  | MaxToolCallsCheck
  | AnswerContainsCheck
  | AnswerNotContainsCheck
  | NoToolErrorsCheck;

export interface ObservedToolCall {
  name: string;
  isError?: boolean;
}

export interface ObservedRun {
  files: Record<string, string>;
  frontmatter: Record<string, Record<string, unknown>>;
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
  checks: ToolUseCheckResult[];
}

export interface RunUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
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

export interface CaseRunSummaryInput {
  status: "pass" | "fail" | "skipped-budget" | string;
  usage: RunUsage;
  usd: number;
  ms: number;
}

export interface CaseSummary {
  runs: number;
  executed: number;
  passed: number;
  skipped: number;
  passRate: number;
  meanTokens: number;
  maxTokens: number;
  totalUsd: number;
  meanUsd: number;
  meanMs: number;
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
  const casesRaw = asArray(suite.cases, "suite.cases", problems) ?? [];
  if (casesRaw.length === 0) problems.push("suite.cases must contain at least one case.");

  const cases = casesRaw.map((entry, index) => validateCase(entry, index, problems));
  const seen = new Set<string>();
  for (const evalCase of cases) {
    if (!evalCase) continue;
    if (seen.has(evalCase.id)) problems.push(`Duplicate tool-use case id: ${evalCase.id}.`);
    seen.add(evalCase.id);
  }

  if (problems.length > 0) throw validationError(problems);

  return {
    version: TOOL_USE_SUITE_VERSION,
    name,
    description,
    model,
    runsPerCase: runsPerCase as number,
    budget: budget as ToolUseBudgetCaps,
    turn: turn as ToolUseTurnLimits,
    cases: cases as ToolUseCase[],
  };
}

export function gradeRun(caseDef: ToolUseCase, observed: ObservedRun): GradeResult {
  const checks = caseDef.checks.map((check) => evaluateCheck(check, caseDef, observed));
  return { ok: checks.every((check) => check.ok), checks };
}

export function summarizeCase(runs: CaseRunSummaryInput[]): CaseSummary {
  const skipped = runs.filter((run) => run.status === "skipped-budget").length;
  const executed = runs.filter((run) => run.status !== "skipped-budget");
  const passed = executed.filter((run) => run.status === "pass").length;
  const tokenCounts = executed.map((run) => tokenCount(run.usage));
  const totalUsd = executed.reduce((total, run) => total + finite(run.usd), 0);
  const mean = (value: number): number => (executed.length > 0 ? value / executed.length : 0);

  return {
    runs: runs.length,
    executed: executed.length,
    passed,
    skipped,
    passRate: executed.length > 0 ? passed / executed.length : 0,
    meanTokens: mean(tokenCounts.reduce((total, count) => total + count, 0)),
    maxTokens: tokenCounts.length > 0 ? Math.max(...tokenCounts) : 0,
    totalUsd,
    meanUsd: mean(totalUsd),
    meanMs: mean(executed.reduce((total, run) => total + finite(run.ms), 0)),
  };
}

export function costUsd(usage: RunUsage, pricing: RunPricing): number {
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

function validateCase(input: unknown, index: number, problems: string[]): ToolUseCase | undefined {
  const at = `suite.cases[${index}]`;
  const evalCase = asRecord(input, at, problems);
  if (!evalCase) return undefined;
  const id = readString(evalCase.id, `${at}.id`, problems);
  if (id.includes("/") || id.includes("\\")) problems.push(`${at}.id must not contain a path separator.`);
  const prompt = readString(evalCase.prompt, `${at}.prompt`, problems);

  const seedRecord = asRecord(evalCase.seed, `${at}.seed`, problems);
  const filesRecord = seedRecord ? asRecord(seedRecord.files, `${at}.seed.files`, problems) : undefined;
  const files: Record<string, string> = {};
  if (filesRecord) {
    for (const [filePath, content] of Object.entries(filesRecord)) {
      if (typeof content !== "string") {
        problems.push(`${at}.seed.files.${filePath} must be a string.`);
        continue;
      }
      files[filePath] = content;
    }
  }

  const settings = validateSettings(evalCase.settings, `${at}.settings`, problems);
  const checksRaw = asArray(evalCase.checks, `${at}.checks`, problems) ?? [];
  if (checksRaw.length === 0) problems.push(`${at}.checks must contain at least one check.`);
  const checks = checksRaw
    .map((entry, checkIndex) => validateCheck(entry, `${at}.checks[${checkIndex}]`, problems))
    .filter((check): check is ToolUseCheck => check !== undefined);

  return { id, prompt, seed: { files }, settings, checks };
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
      return { type, path: readString(check.path, `${at}.path`, problems) };
    case "file_absent":
      return { type, path: readString(check.path, `${at}.path`, problems) };
    case "file_contains": {
      const regex = readOptionalBoolean(check.regex, `${at}.regex`, problems);
      const text = readString(check.text, `${at}.text`, problems);
      validateRegex(text, regex, `${at}.text`, problems);
      return { type, path: readString(check.path, `${at}.path`, problems), text, regex };
    }
    case "file_not_contains": {
      const regex = readOptionalBoolean(check.regex, `${at}.regex`, problems);
      const text = readString(check.text, `${at}.text`, problems);
      validateRegex(text, regex, `${at}.text`, problems);
      return { type, path: readString(check.path, `${at}.path`, problems), text, regex };
    }
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
    case "unchanged":
      return { type, path: readString(check.path, `${at}.path`, problems) };
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
    case "answer_contains": {
      const regex = readOptionalBoolean(check.regex, `${at}.regex`, problems);
      const text = readString(check.text, `${at}.text`, problems);
      validateRegex(text, regex, `${at}.text`, problems);
      return { type, text, regex };
    }
    case "answer_not_contains": {
      const regex = readOptionalBoolean(check.regex, `${at}.regex`, problems);
      const text = readString(check.text, `${at}.text`, problems);
      validateRegex(text, regex, `${at}.text`, problems);
      return { type, text, regex };
    }
    case "no_tool_errors":
      return { type };
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
      const matches = matchesText(content, check.text, check.regex === true);
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
      if (seedContent === undefined) return result(check, false, `${check.path} is not a seeded file`);
      const content = observed.files[check.path];
      const ok = content === seedContent;
      return result(check, ok, ok ? `${check.path} is unchanged` : `${check.path} changed`);
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
    case "answer_contains": {
      const matches = matchesText(observed.answer, check.text, check.regex === true);
      return result(check, matches, `answer ${matches ? "contains" : "does not contain"} ${JSON.stringify(check.text)}`);
    }
    case "answer_not_contains": {
      const matches = matchesText(observed.answer, check.text, check.regex === true);
      return result(check, !matches, `answer ${matches ? "contains" : "does not contain"} ${JSON.stringify(check.text)}`);
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
  const sortedExpected = [...expected].sort();
  const sortedActual = [...actual].sort();
  return sortedExpected.every((item, index) => item === sortedActual[index]);
}

function matchesText(text: string, pattern: string, regex: boolean): boolean {
  if (!regex) return text.includes(pattern);
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

function hasFile(observed: ObservedRun, path: string): boolean {
  return hasOwn(observed.files, path);
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

function readOptionalBoolean(input: unknown, at: string, problems: string[]): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "boolean") {
    problems.push(`${at} must be a boolean.`);
    return undefined;
  }
  return input;
}

function validateRegex(text: string, regex: boolean | undefined, at: string, problems: string[]): void {
  if (!regex || !text) return;
  try {
    new RegExp(text);
  } catch (error) {
    problems.push(`${at} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

function isFrontmatterValue(value: unknown): value is string | number | boolean | string[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
