/**
 * The contract between the tool-use runner and the WDIO spec that drives
 * Obsidian. The runner writes one `plan.json`; the spec executes it and writes
 * one run record per planned run; the runner reads the records back and grades
 * them. Both sides import these types, so the two processes cannot drift.
 *
 * Pure: no Obsidian, no filesystem, no network.
 */

import {
  type ObservedRun,
  type ObservedToolCall,
  type RunPricing,
  type RunUsage,
  type ThinkingLevelSource,
  type ToolUseBudgetCaps,
  type ToolUseCase,
  type ToolUseSuite,
  type ToolUseThinkingLevel,
  type ToolUseTurnLimits,
} from "./tool-use-core";
import { generateVault } from "./vault-generator";

export const TOOL_USE_PLAN_VERSION = 1;

/** Replaced in a case prompt by the base URL of this run's fixture server. */
export const FIXTURE_PLACEHOLDER = "{{fixture}}";

export interface PlannedRun {
  caseId: string;
  /** 1-based run number within the case. */
  run: number;
}

export interface ToolUsePlan {
  version: typeof TOOL_USE_PLAN_VERSION;
  runId: string;
  suite: { name: string; description?: string; path: string };
  model: string;
  runsPerCase: number;
  /** Run-level reasoning level and where it came from (cli, env, suite, default). */
  thinkingLevel: ToolUseThinkingLevel;
  thinkingLevelSource: ThinkingLevelSource;
  budget: ToolUseBudgetCaps;
  turn: ToolUseTurnLimits;
  prices: RunPricing;
  /** The commit the run measured; a baseline written later from this run uses it. */
  gitHead?: string;
  /** Base URL of the local fixture server; absent when no case needs it. */
  fixtureBaseUrl?: string;
  /** MCP endpoint of the local fake MCP server; absent when no case needs it. */
  mcpFixtureUrl?: string;
  /**
   * Cases with the generated vault and the fixture URL already expanded. Each
   * case carries its effective `thinkingLevel` (a case pin wins over the run level).
   */
  cases: ToolUseCase[];
  runs: PlannedRun[];
}

/** What the spec saw in one run. The runner grades it; the spec never does. */
export interface RunRecord {
  caseId: string;
  run: number;
  ms: number;
  usage: RunUsage;
  modelCalls: number;
  /** Level read from the session `thinking_level_change` entry, when present. Reporting only. */
  observedThinkingLevel?: string;
  observed: ObservedRun;
  /** The harness could not finish the run. The observation is best-effort. */
  error?: string;
  /** The budget cap that was reached before this run could start. */
  skippedBudget?: string;
}

export function emptyObservation(): ObservedRun {
  return { files: {}, paths: [], frontmatter: {}, links: {}, unresolvedLinks: {}, toolCalls: [], answer: "" };
}

export interface CaseSelection {
  /** Explicit case ids, in run order. Duplicates run once. */
  caseIds?: string[];
  /** Run the suite's own `smoke` slice. */
  smoke?: boolean;
}

export function selectCases(suite: ToolUseSuite, selection: CaseSelection = {}): ToolUseCase[] {
  const byId = new Map(suite.cases.map((evalCase) => [evalCase.id, evalCase]));
  if (selection.smoke) {
    if (selection.caseIds?.length) throw new Error("--smoke cannot be combined with --case; use one selector.");
    if (!suite.smoke?.length) {
      throw new Error(`Suite ${suite.name} defines no smoke slice. Add a "smoke" list of case ids to the suite file.`);
    }
    // The validator has already checked every smoke id against the cases.
    return suite.smoke.map((id) => byId.get(id) as ToolUseCase);
  }
  if (!selection.caseIds?.length) return suite.cases;
  const selected = new Map<string, ToolUseCase>();
  for (const id of selection.caseIds) {
    const evalCase = byId.get(id);
    if (!evalCase) throw new Error(`No tool-use case found with id: ${id}`);
    selected.set(id, evalCase);
  }
  return [...selected.values()];
}

export function planRuns(cases: readonly ToolUseCase[], runsPerCase: number): PlannedRun[] {
  return cases.flatMap((evalCase) =>
    Array.from({ length: runsPerCase }, (_, index) => ({ caseId: evalCase.id, run: index + 1 })),
  );
}

/**
 * Expand `seed.vault` into concrete notes. Case `seed.files` win over the
 * generated base, so a case can add or replace needles. Grading uses the same
 * expanded case, so `unchanged` sees the real seed and not only the
 * hand-written files.
 */
export function expandCaseSeed(evalCase: ToolUseCase): ToolUseCase {
  const vaultSeed = evalCase.seed.vault;
  if (!vaultSeed) return evalCase;
  const generated = generateVault(vaultSeed.size, vaultSeed.seed);
  return {
    ...evalCase,
    seed: {
      files: { ...generated.files, ...evalCase.seed.files },
      binaryFiles: evalCase.seed.binaryFiles,
    },
  };
}

/**
 * True when a case needs the local fixture server: its prompt names the
 * fixture URL, or it turns web access on. A suite with neither starts no
 * server.
 */
export function needsFixture(cases: readonly ToolUseCase[]): boolean {
  return cases.some(
    (evalCase) => evalCase.prompt.includes(FIXTURE_PLACEHOLDER) || evalCase.settings?.["web.enabled"] === true,
  );
}

/**
 * True when a case needs the local fake MCP server: it turns MCP on for that
 * case with `"mcp.enabled": true`. A suite with no such case starts no server.
 */
export function needsMcpFixture(cases: readonly ToolUseCase[]): boolean {
  return cases.some((evalCase) => evalCase.settings?.["mcp.enabled"] === true);
}

/**
 * The fixture URL fields of a plan. A URL is written only when a selected case
 * needs that server, so a suite with no fixture case has neither field.
 */
export function fixturePlanFields(
  cases: readonly ToolUseCase[],
  urls: { web?: string; mcp?: string },
): Pick<ToolUsePlan, "fixtureBaseUrl" | "mcpFixtureUrl"> {
  return {
    ...(needsFixture(cases) && urls.web ? { fixtureBaseUrl: urls.web } : {}),
    ...(needsMcpFixture(cases) && urls.mcp ? { mcpFixtureUrl: urls.mcp } : {}),
  };
}

/**
 * Replace every `{{fixture}}` in the case prompts with the fixture server's
 * base URL. A prompt that names the fixture with no URL fails here instead of
 * sending the model a broken address.
 */
export function expandFixturePlaceholders(
  cases: readonly ToolUseCase[],
  baseUrl: string | undefined,
): ToolUseCase[] {
  return cases.map((evalCase) => {
    if (!evalCase.prompt.includes(FIXTURE_PLACEHOLDER)) return evalCase;
    if (!baseUrl) {
      throw new Error(
        `Case ${evalCase.id} uses ${FIXTURE_PLACEHOLDER} in its prompt, but no fixture server base URL is available.`,
      );
    }
    return { ...evalCase, prompt: evalCase.prompt.replaceAll(FIXTURE_PLACEHOLDER, baseUrl) };
  });
}

/**
 * Read one run record back from disk. The spec writes it, but a crash can
 * leave any shape behind, so every field is checked. A record that does not
 * name its run is rejected; the runner reports that run as a harness error.
 */
export function parseRunRecord(input: unknown, at: string): RunRecord {
  if (!isRecord(input)) throw new Error(`Run record is not an object: ${at}`);
  const caseId = typeof input.caseId === "string" ? input.caseId : "";
  const run = finiteNumber(input.run);
  if (!caseId || run === undefined) throw new Error(`Run record is missing caseId or run: ${at}`);
  if (!isRecord(input.observed)) throw new Error(`Run record has no observation: ${at}`);
  const observed = input.observed;
  return {
    caseId,
    run,
    ms: finiteNumber(input.ms) ?? 0,
    usage: usageValue(input.usage),
    modelCalls: finiteNumber(input.modelCalls) ?? 0,
    ...(typeof input.observedThinkingLevel === "string" && input.observedThinkingLevel
      ? { observedThinkingLevel: input.observedThinkingLevel }
      : {}),
    observed: {
      files: recordOf(observed.files, (value): value is string => typeof value === "string"),
      ...(Array.isArray(observed.paths) ? { paths: stringList(observed.paths) } : {}),
      frontmatter: recordOf(observed.frontmatter, isRecord),
      links: linkMap(observed.links),
      unresolvedLinks: linkMap(observed.unresolvedLinks),
      toolCalls: toolCalls(observed.toolCalls),
      answer: typeof observed.answer === "string" ? observed.answer : "",
    },
    ...(typeof input.error === "string" && input.error ? { error: input.error } : {}),
    ...(typeof input.skippedBudget === "string" && input.skippedBudget
      ? { skippedBudget: input.skippedBudget }
      : {}),
  };
}

function recordOf<T>(input: unknown, accept: (value: unknown) => value is T): Record<string, T> {
  const output: Record<string, T> = {};
  if (!isRecord(input)) return output;
  for (const [key, value] of Object.entries(input)) {
    if (accept(value)) output[key] = value;
  }
  return output;
}

function stringList(input: unknown[]): string[] {
  return input.filter((value): value is string => typeof value === "string");
}

function linkMap(input: unknown): Record<string, string[]> {
  const lists = recordOf(input, (value): value is unknown[] => Array.isArray(value));
  return Object.fromEntries(Object.entries(lists).map(([from, targets]) => [from, stringList(targets)]));
}

function toolCalls(input: unknown): ObservedToolCall[] {
  if (!Array.isArray(input)) return [];
  return input.filter(isRecord).map((call) => ({
    name: typeof call.name === "string" ? call.name : "(unknown)",
    isError: call.isError === true,
  }));
}

function usageValue(input: unknown): RunUsage {
  if (!isRecord(input)) return {};
  return {
    input: finiteNumber(input.input),
    output: finiteNumber(input.output),
    cacheRead: finiteNumber(input.cacheRead),
    cacheWrite: finiteNumber(input.cacheWrite),
    totalTokens: finiteNumber(input.totalTokens),
    billedUsd: finiteNumber(input.billedUsd),
  };
}

function finiteNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input);
}
