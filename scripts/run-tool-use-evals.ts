import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { applyEnvFile } from "./live-env.mjs";
import type {
  CaseSummary,
  RunPricing,
  RunUsage,
  ToolUseBudgetCaps,
  ToolUseCase,
  ToolUseCheckResult,
  ToolUseSuite,
} from "./eval/tool-use-core";

const DEFAULT_SUITE = "test/evals/tool-use/tool-use.eval.json";
const DEFAULT_OUT_ROOT = "logs/eval-runs";
const BASELINE_PATH = "test/evals/baselines/tool-use.json";
const MODELS_URL = "https://openrouter.ai/api/v1/models";

// The dry run must not touch the network. These rough per-token assumptions only
// make the plan readable; the live run replaces them with fetched prices.
const DRY_RUN_ESTIMATE = {
  inputTokensPerRun: 4_000,
  outputTokensPerRun: 800,
  inputUsdPerToken: 0.00000028,
  outputUsdPerToken: 0.0000011,
};

interface CliArgs {
  suite?: string;
  cases?: string[];
  runs?: string;
  runId?: string;
  outDir?: string;
  envFile?: string;
  maxUsd?: string;
  dryRun: boolean;
  writeBaseline: boolean;
  compare?: [string, string];
}

interface PlannedRun {
  caseId: string;
  run: number;
}

interface RunFile {
  caseId: string;
  run: number;
  files: Record<string, string>;
  frontmatter: Record<string, Record<string, unknown>>;
  toolCalls: Array<{ name: string; isError?: boolean }>;
  answer: string;
  usage: RunUsage;
  modelCalls: number;
  ms: number;
  status?: string;
  error?: string;
}

interface CaseRunEntry {
  run: number;
  status: string;
  ms: number;
  usage: RunUsage;
  modelCalls: number;
  usd: number;
  checks: ToolUseCheckResult[];
  error?: string;
}

interface CaseSummaryWithRuns extends CaseSummary {
  id: string;
  runResults: CaseRunEntry[];
}

interface ToolUseSummary {
  version: 1;
  runId: string;
  suite: { name: string; description?: string; path: string };
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  prices: RunPricing;
  budget: { caps: ToolUseBudgetCaps; used: { usd: number; modelCalls: number; tokens: number }; exceeded: string | null };
  cases: CaseSummaryWithRuns[];
}

void main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.compare) {
    await compareCommand(args.compare);
    return;
  }

  const core = await import("./eval/tool-use-core");
  const suitePath = path.resolve(args.suite ?? DEFAULT_SUITE);
  const suite = core.validateToolUseSuite(JSON.parse(await readFile(suitePath, "utf8")) as unknown);
  const runsPerCase = args.runs === undefined ? suite.runsPerCase : positiveInteger(args.runs, "--runs");
  const cases = selectCases(suite, args.cases);
  const plannedRuns = planRuns(cases, runsPerCase);
  const runId = args.runId ?? timestampRunId();
  const outDir = path.resolve(args.outDir ?? path.join(DEFAULT_OUT_ROOT, runId));
  const resultsDir = path.join(outDir, "results");
  const budget: ToolUseBudgetCaps =
    args.maxUsd === undefined ? suite.budget : { ...suite.budget, maxUsd: nonNegativeNumber(args.maxUsd, "--max-usd") };

  if (args.dryRun) {
    printDryRun({
      suite,
      suitePath,
      cases,
      runsPerCase,
      plannedRuns,
      budget,
      outDir,
    });
    return;
  }

  await assertFreshResultsDir(resultsDir);

  if (args.envFile) {
    if (!existsSync(args.envFile)) throw new Error(`--env-file does not exist: ${args.envFile}`);
    applyEnvFile(args.envFile);
  }
  const apiKey = process.env.AGENTIC_CHAT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("AGENTIC_CHAT_API_KEY is required. Set it in the environment or pass --env-file; the runner never prints it.");
  }

  const startedAt = new Date();
  const prices = await fetchPricing(suite.model);
  const vaultPath = path.join(outDir, "vault");
  await mkdir(vaultPath, { recursive: true });
  await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  // Keep links working on rename without Obsidian's "Update links?" prompt; a
  // modal would block the turn. Most users turn this on.
  await writeFile(path.join(vaultPath, ".obsidian", "app.json"), `${JSON.stringify({ alwaysUpdateLinks: true })}\n`);
  await mkdir(resultsDir, { recursive: true });

  const plan = {
    version: 1,
    runId,
    suite: { name: suite.name, description: suite.description, path: suitePath },
    model: suite.model,
    runsPerCase,
    budget,
    turn: suite.turn,
    prices,
    cases: cases.map((evalCase) => ({
      id: evalCase.id,
      prompt: evalCase.prompt,
      seed: evalCase.seed,
      settings: evalCase.settings ?? {},
      checks: evalCase.checks,
    })),
    runs: plannedRuns,
  };
  const planPath = path.join(outDir, "plan.json");
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  console.log(`Tool-use eval: ${runId}`);
  console.log(`Vault: ${vaultPath}`);
  console.log(`Plan: ${planPath}`);
  console.log(`Run: ${cases.length} case(s) x ${runsPerCase} run(s) = ${plannedRuns.length} run(s)`);

  const timeoutMs = Math.max(10 * 60 * 1000, plannedRuns.length * suite.turn.timeoutMs + 120_000);
  const exitCode = await runE2e({ vaultPath, planPath, resultsDir, apiKey, timeoutMs });
  if (exitCode !== 0) {
    throw new Error(`The WDIO tool-use spec exited with code ${exitCode}. Results under ${resultsDir} may be incomplete.`);
  }

  const caseById = new Map(cases.map((evalCase) => [evalCase.id, evalCase]));
  const caseEntries = new Map<string, CaseRunEntry[]>();
  for (const evalCase of cases) caseEntries.set(evalCase.id, []);

  for (const planned of plannedRuns) {
    const evalCase = caseById.get(planned.caseId);
    if (!evalCase) throw new Error(`Plan refers to an unknown case: ${planned.caseId}`);
    const resultPath = path.join(resultsDir, evalCase.id, `${planned.run}.json`);
    if (!existsSync(resultPath)) {
      throw new Error(`Missing tool-use result: ${resultPath}`);
    }
    const runFile = parseRunFile(JSON.parse(await readFile(resultPath, "utf8")) as unknown, resultPath);
    const entry = gradeRunFile(core, evalCase, runFile, prices);
    caseEntries.get(evalCase.id)?.push(entry);
  }

  const caseSummaries: CaseSummaryWithRuns[] = cases.map((evalCase) => {
    const runs = caseEntries.get(evalCase.id) ?? [];
    const summary = core.summarizeCase(runs.map((run) => ({
      status: run.status,
      usage: run.usage,
      usd: run.usd,
      ms: run.ms,
    })));
    return { id: evalCase.id, ...summary, runResults: runs };
  });

  const tracker = new core.BudgetTracker(budget, prices);
  for (const run of caseSummaries.flatMap((entry) => entry.runResults)) {
    tracker.add({ usage: run.usage, modelCalls: run.modelCalls });
  }
  const finishedAt = new Date();
  const summary: ToolUseSummary = {
    version: 1,
    runId,
    suite: { name: suite.name, description: suite.description, path: suitePath },
    model: suite.model,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    prices,
    budget: { caps: budget, used: tracker.totals(), exceeded: tracker.exceeded() },
    cases: caseSummaries,
  };

  const summaryPath = path.join(outDir, "summary.json");
  const reportPath = path.join(outDir, "report.md");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(reportPath, formatReport(summary), "utf8");

  if (args.writeBaseline) {
    const baselinePath = await writeBaseline(summary);
    console.log(`Baseline: ${baselinePath}`);
  }

  console.log(formatConsoleSummary(summary, summaryPath, reportPath));
}

function gradeRunFile(
  core: typeof import("./eval/tool-use-core"),
  evalCase: ToolUseCase,
  runFile: RunFile,
  prices: RunPricing,
): CaseRunEntry {
  if (runFile.status === "skipped-budget") {
    return {
      run: runFile.run,
      status: "skipped-budget",
      ms: 0,
      usage: {},
      modelCalls: 0,
      usd: 0,
      checks: [],
      error: runFile.error,
    };
  }

  const grade = core.gradeRun(evalCase, {
    files: runFile.files,
    frontmatter: runFile.frontmatter,
    toolCalls: runFile.toolCalls,
    answer: runFile.answer,
  });
  const usd = core.costUsd(runFile.usage, prices);
  const ok = grade.ok && !runFile.error;
  return {
    run: runFile.run,
    status: ok ? "pass" : "fail",
    ms: runFile.ms,
    usage: runFile.usage,
    modelCalls: runFile.modelCalls,
    usd,
    checks: grade.checks,
    error: runFile.error,
  };
}

function parseRunFile(input: unknown, at: string): RunFile {
  if (!isRecord(input)) throw new Error(`Result is not an object: ${at}`);
  const caseId = typeof input.caseId === "string" ? input.caseId : "";
  const run = numberValue(input.run);
  if (!caseId || run === undefined) throw new Error(`Result is missing caseId or run: ${at}`);
  return {
    caseId,
    run,
    files: stringRecord(input.files),
    frontmatter: frontmatterValue(input.frontmatter),
    toolCalls: toolCallsValue(input.toolCalls),
    answer: typeof input.answer === "string" ? input.answer : "",
    usage: usageValue(input.usage),
    modelCalls: numberValue(input.modelCalls) ?? 0,
    ms: numberValue(input.ms) ?? 0,
    status: typeof input.status === "string" ? input.status : undefined,
    error: typeof input.error === "string" ? input.error : undefined,
  };
}

function stringRecord(input: unknown): Record<string, string> {
  if (!isRecord(input)) return {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") output[key] = value;
  }
  return output;
}

function frontmatterValue(input: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(input)) return {};
  const output: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isRecord(value)) output[key] = value;
  }
  return output;
}

function toolCallsValue(input: unknown): Array<{ name: string; isError?: boolean }> {
  if (!Array.isArray(input)) return [];
  return input
    .filter(isRecord)
    .map((call) => ({
      name: typeof call.name === "string" ? call.name : "(unknown)",
      isError: call.isError === true,
    }));
}

function usageValue(input: unknown): RunUsage {
  if (!isRecord(input)) return {};
  return {
    input: numberValue(input.input),
    output: numberValue(input.output),
    cacheRead: numberValue(input.cacheRead),
    cacheWrite: numberValue(input.cacheWrite),
    totalTokens: numberValue(input.totalTokens),
  };
}

async function fetchPricing(model: string): Promise<RunPricing> {
  const response = await fetch(MODELS_URL);
  if (!response.ok) throw new Error(`OpenRouter models API returned ${response.status}`);
  const payload = (await response.json()) as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("OpenRouter models API returned an unexpected shape.");
  }
  const row = payload.data.filter(isRecord).find((entry) => entry.id === model);
  if (!row) throw new Error(`Model ${model} is not listed at ${MODELS_URL}.`);
  const pricing = isRecord(row.pricing) ? row.pricing : {};
  const input = priceValue(pricing.prompt);
  const output = priceValue(pricing.completion);
  if (input === undefined || output === undefined) {
    throw new Error(`Model ${model} has no usable prompt/completion pricing.`);
  }
  return { input, output, cacheRead: priceValue(pricing.input_cache_read) ?? 0 };
}

function priceValue(input: unknown): number | undefined {
  if (typeof input !== "string") return undefined;
  const value = Number.parseFloat(input);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function planRuns(cases: ToolUseCase[], runsPerCase: number): PlannedRun[] {
  return cases.flatMap((evalCase) =>
    Array.from({ length: runsPerCase }, (_, index) => ({ caseId: evalCase.id, run: index + 1 })),
  );
}

function selectCases(suite: ToolUseSuite, requested: string[] | undefined): ToolUseCase[] {
  if (!requested || requested.length === 0) return suite.cases;
  const ids = requested.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  const selected = ids.map((id) => {
    const evalCase = suite.cases.find((entry) => entry.id === id);
    if (!evalCase) throw new Error(`No tool-use case found with id: ${id}`);
    return evalCase;
  });
  return [...new Map(selected.map((entry) => [entry.id, entry])).values()];
}

function printDryRun(options: {
  suite: ToolUseSuite;
  suitePath: string;
  cases: ToolUseCase[];
  runsPerCase: number;
  plannedRuns: PlannedRun[];
  budget: ToolUseBudgetCaps;
  outDir: string;
}): void {
  const estimatedUsd =
    options.plannedRuns.length *
    (DRY_RUN_ESTIMATE.inputTokensPerRun * DRY_RUN_ESTIMATE.inputUsdPerToken +
      DRY_RUN_ESTIMATE.outputTokensPerRun * DRY_RUN_ESTIMATE.outputUsdPerToken);
  const lines = [
    `Tool-use eval plan: ${options.suite.name}`,
    `Suite: ${options.suitePath}`,
    `Model: ${options.suite.model}`,
    `Cases: ${options.cases.length}; ${options.cases.length} case(s) x ${options.runsPerCase} run(s) = ${options.plannedRuns.length} run(s)`,
  ];
  for (const evalCase of options.cases) lines.push(`- ${evalCase.id}: ${options.runsPerCase} run(s)`);
  lines.push(
    `Budget: maxUsd ${options.budget.maxUsd}, maxModelCalls ${options.budget.maxModelCalls}, maxTokens ${options.budget.maxTokens}`,
    `Turn: timeoutMs ${options.suite.turn.timeoutMs}, maxTurnsPerPrompt ${options.suite.turn.maxTurnsPerPrompt}`,
    `Results: ${options.outDir}`,
    "prices: not fetched (dry run)",
    `estimated cost: $${estimatedUsd.toFixed(4)} (rough; assumed per-token prices)`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

function formatReport(summary: ToolUseSummary): string {
  const lines = [
    `# Tool-use eval ${summary.runId}`,
    "",
    `Suite: ${summary.suite.name}`,
    `Model: ${summary.model}`,
    `Prices (USD/token): input ${summary.prices.input}, output ${summary.prices.output}, cache-read ${summary.prices.cacheRead}`,
    `Budget used: $${summary.budget.used.usd.toFixed(6)}, ${summary.budget.used.modelCalls} model call(s), ${summary.budget.used.tokens} token(s)`,
    `Budget exceeded: ${summary.budget.exceeded ?? "no"}`,
    "",
    "| Case | Pass rate | Mean tokens | USD | Mean seconds |",
    "|---|---|---|---|---|",
  ];
  for (const entry of summary.cases) {
    lines.push(
      `| ${entry.id} | ${entry.passed}/${entry.executed} | ${Math.round(entry.meanTokens)} | $${entry.totalUsd.toFixed(6)} | ${(entry.meanMs / 1000).toFixed(1)} |`,
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
      if (run.error) lines.push(`- run error: ${run.error}`);
      for (const check of failed) lines.push(`- ${check.type}: ${check.detail}`);
      lines.push("");
    }
  }
  if (failures === 0) lines.push("- none", "");
  return `${lines.join("\n")}\n`;
}

function formatConsoleSummary(summary: ToolUseSummary, summaryPath: string, reportPath: string): string {
  const passed = summary.cases.reduce((total, entry) => total + entry.passed, 0);
  const executed = summary.cases.reduce((total, entry) => total + entry.executed, 0);
  const lines = [
    `Tool-use eval: ${summary.runId}`,
    `Cases: ${summary.cases.length}; runs: ${executed} executed; passed: ${passed}/${executed}`,
  ];
  for (const entry of summary.cases) {
    lines.push(`- ${entry.id}: ${entry.passed}/${entry.executed} (mean ${Math.round(entry.meanTokens)} tokens, $${entry.totalUsd.toFixed(6)}, ${(entry.meanMs / 1000).toFixed(1)}s)`);
  }
  lines.push(
    `Totals: $${summary.budget.used.usd.toFixed(6)}, ${summary.budget.used.modelCalls} model call(s), ${summary.budget.used.tokens} token(s)`,
    `Summary: ${summaryPath}`,
    `Report: ${reportPath}`,
  );
  return `${lines.join("\n")}\n`;
}

async function assertFreshResultsDir(resultsDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(resultsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.length > 0) {
    throw new Error(
      `run id already used; pick a new --run-id (results directory is not empty: ${resultsDir})`,
    );
  }
}

async function writeBaseline(summary: ToolUseSummary): Promise<string> {
  const baseline = {
    version: 1,
    suite: summary.suite.name,
    model: summary.model,
    prices: summary.prices,
    date: new Date().toISOString(),
    gitHead: gitHead(),
    cases: summary.cases.map((entry) => ({
      id: entry.id,
      passRate: entry.passRate,
      meanTokens: entry.meanTokens,
      meanUsd: entry.meanUsd,
    })),
  };
  const target = path.resolve(BASELINE_PATH);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return target;
}

async function compareCommand(input: [string, string]): Promise<void> {
  const baseline = JSON.parse(await readFile(path.resolve(input[0]), "utf8")) as unknown;
  const candidate = JSON.parse(await readFile(path.resolve(input[1]), "utf8")) as unknown;
  process.stdout.write(formatComparison(baseline, candidate));
}

function formatComparison(baseline: unknown, candidate: unknown): string {
  const before = summaryCases(baseline);
  const after = summaryCases(candidate);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right));
  const lines = [
    "# Tool-use eval comparison",
    "",
    "| Case | Pass rate | Mean tokens | Mean USD |",
    "|---|---|---|---|",
  ];
  for (const id of ids) {
    const left = before.get(id) ?? {};
    const right = after.get(id) ?? {};
    lines.push(
      `| ${id} | ${formatDelta(left.passRate, right.passRate)} | ${formatDelta(left.meanTokens, right.meanTokens)} | ${formatDelta(left.meanUsd, right.meanUsd)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function summaryCases(input: unknown): Map<string, { passRate?: number; meanTokens?: number; meanUsd?: number }> {
  const output = new Map<string, { passRate?: number; meanTokens?: number; meanUsd?: number }>();
  if (!isRecord(input) || !Array.isArray(input.cases)) return output;
  for (const entry of input.cases) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    output.set(entry.id, {
      passRate: numberValue(entry.passRate),
      meanTokens: numberValue(entry.meanTokens),
      meanUsd: numberValue(entry.meanUsd),
    });
  }
  return output;
}

function formatDelta(before: number | undefined, after: number | undefined): string {
  if (before === undefined && after === undefined) return "(missing)";
  const left = before ?? 0;
  const right = after ?? 0;
  const delta = right - left;
  const sign = delta > 0 ? "+" : "";
  return `${left} -> ${right} (${sign}${Number(delta.toFixed(6))})`;
}

function runE2e(options: {
  vaultPath: string;
  planPath: string;
  resultsDir: string;
  apiKey: string;
  timeoutMs: number;
}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(npmCommand(), ["run", "test:e2e"], {
      stdio: "inherit",
      env: {
        ...process.env,
        WDIO_CONFIG: "./wdio.dogfood.conf.mts",
        TARGET_VAULT: options.vaultPath,
        DOGFOOD_COPY: "false",
        DOGFOOD_SPEC: "./test/e2e/evals/tool-use.eval.ts",
        DOGFOOD_TIMEOUT_MS: String(options.timeoutMs),
        TOOL_USE_PLAN: options.planPath,
        TOOL_USE_RESULTS_DIR: options.resultsDir,
        AGENTIC_CHAT_API_KEY: options.apiKey,
        NO_PROXY: mergeNoProxy(process.env.NO_PROXY),
      },
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      process.stderr.write(`Failed to launch the tool-use E2E: ${error.message}\n`);
      resolve(1);
    });
  });
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, writeBaseline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--") continue;
    if (raw === "--help" || raw === "-h") {
      process.stdout.write(usageText());
      process.exit(0);
    }
    if (raw === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (raw === "--write-baseline") {
      args.writeBaseline = true;
      continue;
    }
    if (!raw.startsWith("--")) throw new Error(`Unexpected argument: ${raw}`);
    const key = raw.slice(2);
    if (key === "compare") {
      const baseline = argv[index + 1];
      const candidate = argv[index + 2];
      if (!baseline || baseline.startsWith("--") || !candidate || candidate.startsWith("--")) {
        throw new Error("--compare needs <base-summary.json> <head-summary.json>");
      }
      args.compare = [baseline, candidate];
      index += 2;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    index += 1;
    switch (key) {
      case "suite":
        args.suite = value;
        break;
      case "case":
        args.cases = [...(args.cases ?? []), value];
        break;
      case "runs":
        args.runs = value;
        break;
      case "run-id":
        args.runId = value;
        break;
      case "out-dir":
        args.outDir = value;
        break;
      case "env-file":
        args.envFile = value;
        break;
      case "max-usd":
        args.maxUsd = value;
        break;
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }
  return args;
}

function usageText(): string {
  return [
    "Usage:",
    "  npm run eval:tool-use -- [--suite path] [--case id[,id]] [--runs n] [--run-id id]",
    "      [--out-dir dir] [--env-file path] [--max-usd usd] [--dry-run] [--write-baseline]",
    "  npm run eval:tool-use -- --compare <base-summary.json> <head-summary.json>",
    "",
  ].join("\n");
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

function numberValue(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input);
}

function timestampRunId(): string {
  return `tool-use-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function mergeNoProxy(current: string | undefined): string {
  const required = ["localhost", "127.0.0.1", "::1"];
  const values = new Set((current ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  for (const value of required) values.add(value);
  return [...values].join(",");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
