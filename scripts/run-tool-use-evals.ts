/**
 * CLI for the live tool-use evals. This file only does I/O: it reads the suite,
 * writes the plan, launches the WDIO spec that drives Obsidian, reads the run
 * records back, and writes the summary, report, and baseline. The logic lives
 * in `scripts/eval/tool-use-*.ts`, where the unit tests cover it.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startFixtureServer, type FixtureServer } from "./eval/fixture-server";
import { startFixtureMcpServer, type FixtureMcpServer } from "./eval/fixture-mcp-server";
import { BASELINE_DIR, writeBaselineFiles, writeBaselineFromSummary } from "./eval/baseline-files";
import { inhibitSleep } from "./eval/run-loop";
import { CANARY_RUNS, formatCanary } from "./eval/canary";
import { bootstrapCompare, formatSignificance, type SignificanceCase } from "./eval/significance";
import { formatComparison } from "./eval/tool-use-compare";
import {
  effectiveThinkingLevel,
  resolveThinkingLevel,
  validateToolUseSuite,
  type RunPricing,
  type ToolUseBudgetCaps,
} from "./eval/tool-use-core";
import {
  TOOL_USE_PLAN_VERSION,
  expandCaseSeed,
  expandFixturePlaceholders,
  fixturePlanFields,
  needsMcpFixture,
  needsFixture,
  parseRunRecord,
  planRuns,
  selectCases,
  type ToolUsePlan,
} from "./eval/tool-use-plan";
import {
  baselineFileName,
  buildSummary,
  formatConsoleSummary,
  formatDryRun,
  formatReport,
  gradeRecord,
  missingRunEntry,
  type CaseRunEntry,
} from "./eval/tool-use-report";
import { applyEnvFile } from "./live-env.mjs";

const DEFAULT_SUITE = "test/evals/tool-use/tool-use.eval.json";
const DEFAULT_OUT_ROOT = "logs/eval-runs";
const MODELS_URL = "https://openrouter.ai/api/v1/models";
const SPEC_PATH = "./test/e2e/evals/tool-use.eval.ts";
/** Obsidian start-up and teardown, on top of the per-run turn timeouts. */
const SPEC_OVERHEAD_MS = 120_000;
const MIN_SPEC_TIMEOUT_MS = 10 * 60 * 1000;

const USAGE = `Usage:
  npm run eval:tool-use -- [--suite path] [--case id[,id] | --smoke | --canary] [--runs n] [--run-id id]
      [--out-dir dir] [--env-file path] [--max-usd usd] [--thinking-level level]
      [--dry-run] [--write-baseline]
  npm run eval:tool-use -- --compare <base.json> <head.json> [--significance [--exclude id[,id]]]
  npm run eval:significance -- <base.json> <head.json>
  npm run eval:tool-use -- --write-baseline-from <run>/summary.json [--git-head sha] [--suite path]

  --smoke           runs the suite's own "smoke" slice, once per case unless --runs is set.
  --canary          runs the suite's "canary" slice, 5 times per case unless --runs is set,
                    and prints a Wilson interval per case against the baseline.
  --thinking-level  wins over AGENTIC_CHAT_THINKING_LEVEL, the suite field, and the low default.
  --compare         reads two summary.json or baseline files and prints the differences.
  --significance    adds a case-level bootstrap section to --compare; --exclude drops
                    cases from that section only.
  --write-baseline-from  writes the baseline from a finished run (no model call), with the
                    same refusal rules as --write-baseline; reads plan.json next to it.
`;

interface CliArgs {
  suite: string;
  caseIds: string[];
  smoke: boolean;
  canary: boolean;
  runs?: number;
  runId: string;
  outDir?: string;
  envFile?: string;
  maxUsd?: number;
  thinkingLevel?: string;
  dryRun: boolean;
  writeBaseline: boolean;
  compare?: [baseline: string, candidate: string];
  /** With `compare`: add the bootstrap section after the comparison table. */
  significance: boolean;
  /** Case ids dropped from the significance read only. */
  exclude: string[];
  writeBaselineFrom?: string;
  gitHead?: string;
  help: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      suite: { type: "string" },
      case: { type: "string", multiple: true },
      smoke: { type: "boolean" },
      canary: { type: "boolean" },
      runs: { type: "string" },
      "run-id": { type: "string" },
      "out-dir": { type: "string" },
      "env-file": { type: "string" },
      "max-usd": { type: "string" },
      "thinking-level": { type: "string" },
      "dry-run": { type: "boolean" },
      "write-baseline": { type: "boolean" },
      compare: { type: "boolean" },
      significance: { type: "boolean" },
      exclude: { type: "string", multiple: true },
      "write-baseline-from": { type: "string" },
      "git-head": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const exclude = (values.exclude ?? []).flatMap((value) => value.split(",")).map((id) => id.trim()).filter(Boolean);
  if (values.significance && !values.compare) {
    throw new Error("--significance needs --compare <base.json> <head.json>");
  }
  if (exclude.length > 0 && !values.significance) {
    throw new Error("--exclude only applies to --compare --significance <base.json> <head.json>");
  }
  if (values.compare && positionals.length !== 2) {
    throw new Error("--compare needs <base.json> <head.json>");
  }
  if (!values.compare && positionals.length > 0) throw new Error(`Unexpected argument: ${positionals[0]}`);
  const caseIds = (values.case ?? []).flatMap((value) => value.split(",")).map((id) => id.trim()).filter(Boolean);
  if (values.smoke && caseIds.length > 0) throw new Error("--smoke cannot be combined with --case; use one selector.");
  if (values.canary && (caseIds.length > 0 || values.smoke)) throw new Error("--canary cannot be combined with --case or --smoke.");
  return {
    suite: values.suite ?? DEFAULT_SUITE,
    caseIds,
    smoke: values.smoke === true,
    canary: values.canary === true,
    runs: values.runs === undefined ? undefined : positiveInteger(values.runs, "--runs"),
    runId: values["run-id"] ?? `tool-use-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    outDir: values["out-dir"],
    envFile: values["env-file"],
    maxUsd: values["max-usd"] === undefined ? undefined : nonNegativeNumber(values["max-usd"], "--max-usd"),
    thinkingLevel: values["thinking-level"],
    dryRun: values["dry-run"] === true,
    writeBaseline: values["write-baseline"] === true,
    compare: values.compare ? [positionals[0], positionals[1]] : undefined,
    significance: values.significance === true,
    exclude,
    writeBaselineFrom: values["write-baseline-from"],
    gitHead: values["git-head"],
    help: values.help === true,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.writeBaselineFrom) {
    const written = writeBaselineFromSummary({
      summaryPath: path.resolve(args.writeBaselineFrom),
      gitHead: args.gitHead,
      suitePath: args.suite === DEFAULT_SUITE ? undefined : path.resolve(args.suite),
    });
    console.log(`Baseline: ${written.latest}`);
    console.log(`History: ${written.history}`);
    return;
  }
  if (args.compare) {
    const [baseline, candidate] = await Promise.all(args.compare.map(readJson));
    process.stdout.write(formatComparison(baseline, candidate));
    if (args.significance) process.exitCode = writeSignificance(baseline, candidate, args.exclude);
    return;
  }

  const suitePath = path.resolve(args.suite);
  const suite = validateToolUseSuite(await readJson(suitePath));
  // The smoke slice is a quick look, so it runs each case once by default.
  // The canary needs 5 runs to separate a real drop from noise (Wilson interval).
  const runsPerCase = args.runs ?? (args.smoke ? 1 : args.canary ? CANARY_RUNS : suite.runsPerCase);
  // Load the env file before the dry run, so its printed level is the level a live run uses.
  loadEnvFile(args.envFile);
  const thinking = resolveThinkingLevel({
    cli: args.thinkingLevel,
    env: process.env.AGENTIC_CHAT_THINKING_LEVEL?.trim() || undefined,
    suite: suite.thinkingLevel,
  });
  // A case pin wins over the run level. Store the effective level on every case,
  // so the plan, summary, and baseline need no second resolution step.
  const cases = selectCases(suite, { caseIds: args.caseIds, smoke: args.smoke, canary: args.canary })
    .map(expandCaseSeed)
    .map((evalCase) => ({ ...evalCase, thinkingLevel: effectiveThinkingLevel(evalCase, thinking.level) }));
  const budget: ToolUseBudgetCaps = args.maxUsd === undefined ? suite.budget : { ...suite.budget, maxUsd: args.maxUsd };
  const outDir = path.resolve(args.outDir ?? path.join(DEFAULT_OUT_ROOT, args.runId));

  if (args.dryRun) {
    process.stdout.write(
      formatDryRun({
        suite: { name: suite.name, path: suitePath, model: suite.model },
        cases,
        runsPerCase,
        budget,
        turn: suite.turn,
        outDir,
        thinking,
      }),
    );
    return;
  }

  const resultsDir = path.join(outDir, "results");
  await assertFreshResultsDir(resultsDir);
  const apiKey = readApiKey();
  const startedAt = new Date();
  const prices = await fetchPricing(suite.model);
  const vaultPath = await createVault(outDir);
  await mkdir(resultsDir, { recursive: true }); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.

  // The fixture servers live only for this run. A case that needs one gets its
  // URL through the plan; a run that does not need one starts no server.
  let fixture: FixtureServer | undefined;
  let mcpFixture: FixtureMcpServer | undefined;
  try {
    if (needsFixture(cases)) fixture = await startFixtureServer();
    if (needsMcpFixture(cases)) mcpFixture = await startFixtureMcpServer();
    const plan: ToolUsePlan = {
      version: TOOL_USE_PLAN_VERSION,
      runId: args.runId,
      suite: { name: suite.name, description: suite.description, path: suitePath },
      model: suite.model,
      runsPerCase,
      thinkingLevel: thinking.level,
      thinkingLevelSource: thinking.source,
      budget,
      turn: suite.turn,
      prices,
      gitHead: gitHead(),
      ...fixturePlanFields(cases, { web: fixture?.url, mcp: mcpFixture?.url }),
      cases: expandFixturePlaceholders(cases, fixture?.url),
      runs: planRuns(cases, runsPerCase),
    };
    const planPath = path.join(outDir, "plan.json");
    await writeJson(planPath, plan);

    console.log(`Tool-use eval: ${plan.runId}`);
    console.log(`Vault: ${vaultPath}`);
    console.log(`Plan: ${planPath}`);
    console.log(`Run: ${plan.cases.length} case(s) x ${runsPerCase} run(s) = ${plan.runs.length} run(s)`);

    const specExitCode = await runSpec({
      vaultPath,
      planPath,
      resultsDir,
      apiKey,
      timeoutMs: Math.max(MIN_SPEC_TIMEOUT_MS, plan.runs.length * suite.turn.timeoutMs + SPEC_OVERHEAD_MS),
    });

    // The runs that finished cost real money, so a spec that died half-way
    // still gets a summary. Its missing runs are reported as harness errors.
    const entries = await collectEntries(plan, resultsDir, specExitCode);
    const summary = buildSummary(plan, entries, { startedAt, finishedAt: new Date() });
    const paths = { summary: path.join(outDir, "summary.json"), report: path.join(outDir, "report.md") };
    await writeJson(paths.summary, summary);
    await writeFile(paths.report, formatReport(summary), "utf8");
    process.stdout.write(formatConsoleSummary(summary, paths));
    if (args.canary) {
      const baselinePath = path.resolve(BASELINE_DIR, baselineFileName(suite.name));
      process.stdout.write(`\n${formatCanary(summary, existsSync(baselinePath) ? await readJson(baselinePath) : undefined)}`);
    }

    if (specExitCode !== 0) {
      const died = summary.cases.flatMap((entry) => entry.runResults).find((run) => run.error?.startsWith("harness died:"));
      if (died) throw new Error(`${died.error}. The rest of the plan was not run; the summary is incomplete.`);
      throw new Error(`The WDIO tool-use spec exited with code ${specExitCode}. The summary is incomplete.`);
    }
    if (args.writeBaseline) {
      const written = writeBaselineFiles({
        summary,
        plannedRunCount: plan.runs.length,
        suite,
        gitHead: plan.gitHead ?? gitHead(),
        date: new Date(),
      });
      console.log(`Baseline: ${written.latest}`);
      console.log(`History: ${written.history}`);
    }
  } finally {
    await Promise.all([fixture?.close(), mcpFixture?.close()]);
  }
}

/** Read and grade every planned run. A missing or unreadable record is a harness error, not a crash. */
async function collectEntries(
  plan: ToolUsePlan,
  resultsDir: string,
  specExitCode: number,
): Promise<Map<string, CaseRunEntry[]>> {
  const caseById = new Map(plan.cases.map((evalCase) => [evalCase.id, evalCase]));
  const entries = new Map<string, CaseRunEntry[]>(plan.cases.map((evalCase) => [evalCase.id, []]));
  for (const planned of plan.runs) {
    const evalCase = caseById.get(planned.caseId);
    if (!evalCase) throw new Error(`Plan refers to an unknown case: ${planned.caseId}`);
    const recordPath = path.join(resultsDir, planned.caseId, `${planned.run}.json`);
    let entry: CaseRunEntry;
    try {
      entry = gradeRecord(evalCase, parseRunRecord(await readJson(recordPath), recordPath), plan.prices);
    } catch (error) {
      const reason = existsSync(recordPath)
        ? `unreadable run record: ${errorMessage(error)}`
        : `no run record was written (the WDIO spec exited with code ${specExitCode})`;
      entry = missingRunEntry(planned, reason);
    }
    entries.get(planned.caseId)?.push(entry);
  }
  return entries;
}

/**
 * Print the bootstrap section and return the exit code. An `--exclude` id that
 * names no case in either file is a typo: warn and exit non-zero.
 */
function writeSignificance(baseline: unknown, candidate: unknown, exclude: string[]): number {
  const excluded = new Set(exclude);
  const costComparable = costSourceOf(baseline) === "billed" && costSourceOf(candidate) === "billed";
  const result = bootstrapCompare(significanceCases(baseline, excluded), significanceCases(candidate, excluded), {
    costComparable,
  });
  process.stdout.write(formatSignificance(result, { before: "Baseline", after: "Candidate" }, exclude));
  if (result.paired === 0) {
    // An empty table must not exit 0: it reads like "no change". An old baseline
    // without per-case passAllK (for example tool-use.json) gives this.
    process.stderr.write("error: no case has a usable passAllK on both sides; there is nothing to compare\n");
    return 1;
  }
  const known = new Set([...caseIds(baseline), ...caseIds(candidate)]);
  const unknown = exclude.filter((id) => !known.has(id));
  if (unknown.length === 0) return 0;
  process.stderr.write(`warning: unknown --exclude id: ${unknown.join(", ")}; it is not a case in either summary\n`);
  return 1;
}

/**
 * Only the fields the bootstrap needs. A baseline has no `runResults` and a
 * `summary.json` does; both carry per-case scores. A missing score is passed
 * through as NaN, so the module skips it with a named warning.
 */
function significanceCases(input: unknown, excluded: ReadonlySet<string>): SignificanceCase[] {
  return caseRows(input)
    .filter((entry) => !excluded.has(entry.id as string))
    .map((entry) => ({
      id: entry.id as string,
      passAllK: typeof entry.passAllK === "number" ? entry.passAllK : Number.NaN,
      passRate: typeof entry.passRate === "number" ? entry.passRate : undefined,
      meanUsd: typeof entry.meanUsd === "number" ? entry.meanUsd : undefined,
      medianMs: typeof entry.medianMs === "number" ? entry.medianMs : undefined,
    }));
}

function costSourceOf(input: unknown): string | undefined {
  return input && typeof input === "object" && typeof (input as { costSource?: unknown }).costSource === "string"
    ? (input as { costSource: string }).costSource
    : undefined;
}

function caseIds(input: unknown): string[] {
  return caseRows(input).map((entry) => entry.id as string);
}

function caseRows(input: unknown): Array<Record<string, unknown>> {
  if (!input || typeof input !== "object" || !Array.isArray((input as { cases?: unknown }).cases)) return [];
  return ((input as { cases: unknown[] }).cases).filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string",
  );
}

function loadEnvFile(envFile: string | undefined): void {
  if (!envFile) return;
  if (!existsSync(envFile)) throw new Error(`--env-file does not exist: ${envFile}`);
  applyEnvFile(envFile);
}

function readApiKey(): string {
  const apiKey = process.env.AGENTIC_CHAT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "AGENTIC_CHAT_API_KEY is required. Set it in the environment or pass --env-file; the runner never prints it.",
    );
  }
  return apiKey;
}

async function createVault(outDir: string): Promise<string> {
  const vaultPath = path.join(outDir, "vault");
  await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true }); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  // Keep links working on rename without Obsidian's "Update links?" prompt; a
  // modal would block the turn. Most users turn this on.
  await writeJson(path.join(vaultPath, ".obsidian", "app.json"), { alwaysUpdateLinks: true });
  return vaultPath;
}

async function fetchPricing(model: string): Promise<RunPricing> {
  const response = await fetch(MODELS_URL);
  if (!response.ok) throw new Error(`OpenRouter models API returned ${response.status}`);
  const payload = (await response.json()) as { data?: Array<{ id?: unknown; pricing?: Record<string, unknown> }> };
  if (!Array.isArray(payload?.data)) throw new Error("OpenRouter models API returned an unexpected shape.");
  const row = payload.data.find((entry) => entry?.id === model);
  if (!row) throw new Error(`Model ${model} is not listed at ${MODELS_URL}.`);
  const price = (name: string): number | undefined => {
    const value = Number.parseFloat(String(row.pricing?.[name]));
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const input = price("prompt");
  const output = price("completion");
  if (input === undefined || output === undefined) {
    throw new Error(`Model ${model} has no usable prompt/completion pricing.`);
  }
  return { input, output, cacheRead: price("input_cache_read") ?? 0, cacheWrite: price("input_cache_write") ?? 0 };
}

async function assertFreshResultsDir(resultsDir: string): Promise<void> {
  const entries = await readdir(resultsDir).catch((error: NodeJS.ErrnoException) => { // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (entries.length > 0) {
    throw new Error(`run id already used; pick a new --run-id (results directory is not empty: ${resultsDir})`);
  }
}

function runSpec(options: {
  vaultPath: string;
  planPath: string;
  resultsDir: string;
  apiKey: string;
  timeoutMs: number;
}): Promise<number> {
  return new Promise((resolve) => {
    // A laptop sleep kills the Obsidian session (#392 item 5): block it for the run.
    const [command, commandArgs] = inhibitSleep(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "test:e2e"], "agentic-chat eval");
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        WDIO_CONFIG: "./wdio.dogfood.conf.mts",
        TARGET_VAULT: options.vaultPath,
        DOGFOOD_COPY: "false",
        DOGFOOD_SPEC: SPEC_PATH,
        DOGFOOD_TIMEOUT_MS: String(options.timeoutMs),
        TOOL_USE_PLAN: options.planPath,
        TOOL_USE_RESULTS_DIR: options.resultsDir,
        AGENTIC_CHAT_API_KEY: options.apiKey,
        NO_PROXY: withLoopback(process.env.NO_PROXY),
      },
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      process.stderr.write(`Failed to launch the tool-use E2E: ${error.message}\n`);
      resolve(1);
    });
  });
}

/** The WDIO control plane and the fixture server are on loopback; keep them off any proxy. */
function withLoopback(noProxy: string | undefined): string {
  const hosts = (noProxy ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return [...new Set([...hosts, "localhost", "127.0.0.1", "::1"])].join(",");
}

function gitHead(): string {
  try {
    return execFileSync(
      "git", // NOSONAR:S4036 -- git is the repository tool, resolved from PATH like the other scripts.
      ["rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "unknown";
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(file), "utf8")) as unknown; // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be an integer of at least 1.`);
  return parsed;
}

function nonNegativeNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number.`);
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  });
}
