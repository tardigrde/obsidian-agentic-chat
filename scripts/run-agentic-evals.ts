import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { DEFAULT_SYSTEM_PROMPT } from "../src/agent/default-system-prompt";
import { formatExternalWorkspaceForSystemPrompt } from "../src/agent/external-workspace-prompt";
import { estimateToolDefinitionTokens } from "../src/agent/tool-budget";
import type { ExternalWorkspaceSettings } from "../src/settings";
import { createExternalWorkspaceTools } from "../src/tools/external-workspace";
import { BUILTIN_TOOL_NAMES, type BuiltinToolSurface } from "../src/tools/tool-contracts";
import { vaultToolDefinitionsForSurface } from "../src/tools/vault-tool-definitions";
import {
  evaluateScriptedDogfoodCase,
  evaluateStaticContextCase,
  skippedEvalCase,
  validateEvalSuite,
  type AgenticEvalCase,
  type EvalCaseResult,
  type EvalSuite,
  type LlmJudgeEvalCase,
  type ScriptedDogfoodEvalCase,
  type ScriptedDogfoodSnapshot,
  type SessionTraceSnapshot,
  type StaticContextEvalCase,
  type StaticContextSnapshot,
} from "./agentic-eval-core";
import {
  buildJudgePacket,
  resolveJudgeConfig,
  runJudge,
  type JudgeRunResult,
} from "./agentic-eval-judge";
import { assertDogfoodInvariants, loadDogfoodManifest, type DogfoodManifest } from "./dogfood-core";

const DEFAULT_SUITE = "test/evals/agentic-chat/context-and-dogfood.eval.json";
const DEFAULT_OUT_ROOT = "logs/eval-runs";
const DEFAULT_DOGFOOD_REPORT_ROOT = "logs/dogfood-runs";

interface CliArgs {
  suite?: string;
  case?: string;
  "out-dir"?: string;
  "run-id"?: string;
  "run-scripted"?: boolean;
  "dogfood-run-id"?: string;
  "dogfood-run-dir"?: string;
  "dogfood-report-dir"?: string;
  "allow-problems"?: boolean;
  "expect-problems"?: boolean;
  "run-judge"?: boolean;
  "judge-cache-dir"?: string;
  strict?: boolean;
}

interface EvalRunSummary {
  runId: string;
  suite: Pick<EvalSuite, "name" | "description">;
  suitePath: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: EvalCaseResult[];
  totals: {
    cases: number;
    passed: number;
    problems: number;
    skipped: number;
    errors: number;
    warnings: number;
  };
}

interface AnalyzeSessionModule {
  analyzePath(input: string): SessionTraceSnapshot;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const runId = args["run-id"] ?? timestampRunId();
  const suitePath = path.resolve(args.suite ?? DEFAULT_SUITE);
  const outDir = path.resolve(args["out-dir"] ?? path.join(DEFAULT_OUT_ROOT, runId));
  await mkdir(outDir, { recursive: true });

  const suite = validateEvalSuite(JSON.parse(await readFile(suitePath, "utf8")) as unknown);
  const cases = selectCases(suite, args.case);
  const results: EvalCaseResult[] = [];
  for (const evalCase of cases) {
    if (evalCase.type === "static-context") {
      results.push(await runStaticContextCase(evalCase, outDir));
    } else if (evalCase.type === "scripted-dogfood") {
      results.push(await runScriptedDogfoodCase(evalCase, { args, runId, outDir }));
    } else {
      results.push(await runJudgeCase(evalCase, { args, runId, outDir }));
    }
  }

  const finishedAt = new Date();
  const summary: EvalRunSummary = {
    runId,
    suite: { name: suite.name, description: suite.description },
    suitePath,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    results,
    totals: totals(results),
  };
  const summaryJsonPath = path.join(outDir, "summary.json");
  const summaryMdPath = path.join(outDir, "summary.md");
  await writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(summaryMdPath, formatSummary(summary), "utf8");

  process.stdout.write(formatConsoleSummary(summary, summaryMdPath, summaryJsonPath));
  if (args["expect-problems"] && summary.totals.errors + summary.totals.warnings === 0) {
    process.stderr.write("Expected at least one eval finding, but none were reported.\n");
    process.exit(1);
  }
  if (!args["allow-problems"]) {
    if (summary.totals.errors > 0) process.exit(1);
    if (args.strict && summary.totals.warnings > 0) process.exit(1);
  }
}

async function runStaticContextCase(evalCase: StaticContextEvalCase, outDir: string): Promise<EvalCaseResult> {
  const snapshot = createStaticContextSnapshot(evalCase);
  const caseDir = await ensureCaseDir(outDir, evalCase.id);
  const snapshotPath = path.join(caseDir, "static-context.json");
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const result = evaluateStaticContextCase(evalCase, snapshot);
  return {
    ...result,
    artifacts: { ...(result.artifacts ?? {}), snapshot: snapshotPath },
  };
}

function createStaticContextSnapshot(evalCase: StaticContextEvalCase): StaticContextSnapshot {
  const baseSystemPrompt = evalCase.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  const userPrompt = evalCase.prompt ?? "";
  const externalSettings = staticExternalWorkspaceSettings(evalCase);
  const externalPrompt = formatExternalWorkspaceForSystemPrompt(externalSettings);
  const systemPrompt = [baseSystemPrompt, externalPrompt].filter(Boolean).join("\n\n");
  const tools = [
    ...vaultToolDefinitionsForSurface(evalCase.toolSurface as BuiltinToolSurface | undefined),
    ...createExternalWorkspaceTools(externalSettings),
  ];
  const contextMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  return {
    systemPrompt,
    userPrompt,
    contextChars: JSON.stringify(contextMessages).length,
    toolSchemaTokens: estimateToolDefinitionTokens(tools as unknown as AgentTool[]),
    knownToolNames: [...new Set([...BUILTIN_TOOL_NAMES, ...tools.map((tool) => tool.name)])],
    tools: tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };
}

function staticExternalWorkspaceSettings(evalCase: StaticContextEvalCase): ExternalWorkspaceSettings {
  return {
    enabled: evalCase.externalWorkspace?.enabled === true,
    rootPath: evalCase.externalWorkspace?.rootPath ?? "",
    approval: "ask",
    honorGitignore: true,
    ignoredGlobs: "",
  };
}

async function runScriptedDogfoodCase(
  evalCase: ScriptedDogfoodEvalCase,
  context: { args: CliArgs; runId: string; outDir: string },
): Promise<EvalCaseResult> {
  const reportRoot = path.resolve(context.args["dogfood-report-dir"] ?? DEFAULT_DOGFOOD_REPORT_ROOT);
  const dogfoodRunId = context.args["dogfood-run-id"] ?? `${context.runId}-${slug(evalCase.id)}`;
  const runDir = path.resolve(context.args["dogfood-run-dir"] ?? path.join(reportRoot, dogfoodRunId));
  const shouldRun = context.args["run-scripted"] === true;

  if (!shouldRun && !(await exists(runDir))) {
    return skippedEvalCase(evalCase, `No dogfood run dir exists at ${runDir}; pass --run-scripted to generate it.`);
  }

  if (shouldRun) {
    const e2eExitCode = await runDogfoodE2e({
      evalCase,
      dogfoodRunId,
      runDir,
      reportRoot,
    });
    const snapshot = await loadDogfoodSnapshot({ dogfoodRunId, runDir, e2eExitCode });
    return writeScriptedDogfoodResult(evalCase, context.outDir, reportRoot, dogfoodRunId, snapshot);
  }

  const snapshot = await loadDogfoodSnapshot({ dogfoodRunId, runDir });
  return writeScriptedDogfoodResult(evalCase, context.outDir, reportRoot, dogfoodRunId, snapshot);
}

async function loadDogfoodSnapshot(options: {
  dogfoodRunId: string;
  runDir: string;
  e2eExitCode?: number;
}): Promise<ScriptedDogfoodSnapshot> {
  const snapshot: ScriptedDogfoodSnapshot = {
    dogfoodRunId: options.dogfoodRunId,
    runDir: options.runDir,
    e2eExitCode: options.e2eExitCode,
    setupErrors: [],
  };
  const manifestPath = path.join(options.runDir, "vault", ".dogfood", "manifest.json");
  const sessionDir = path.join(options.runDir, "vault", ".obsidian", "plugins", "agentic-chat", "sessions");
  if (await exists(manifestPath)) {
    try {
      const result = await assertDogfoodInvariants(manifestPath);
      snapshot.invariant = {
        ok: result.ok,
        findings: result.findings,
        metrics: {
          maxUserMessageChars: result.metrics.maxUserMessageChars,
          toolStarts: result.metrics.toolStarts,
          toolErrors: result.metrics.toolErrors,
        },
      };
    } catch (error) {
      snapshot.setupErrors?.push(`Dogfood invariant oracle failed to read artifacts: ${errorMessage(error)}`);
    }
  } else {
    snapshot.setupErrors?.push(`Dogfood manifest not found: ${manifestPath}`);
  }

  if (await exists(sessionDir)) {
    try {
      const analyzer = await loadSessionAnalyzer();
      snapshot.trace = analyzer.analyzePath(sessionDir);
    } catch (error) {
      snapshot.setupErrors?.push(`Session trace analyzer failed: ${errorMessage(error)}`);
    }
  } else {
    snapshot.setupErrors?.push(`Dogfood session directory not found: ${sessionDir}`);
  }
  return snapshot;
}

async function writeScriptedDogfoodResult(
  evalCase: ScriptedDogfoodEvalCase,
  outDir: string,
  reportRoot: string,
  dogfoodRunId: string,
  snapshot: ScriptedDogfoodSnapshot,
): Promise<EvalCaseResult> {
  const caseDir = await ensureCaseDir(outDir, evalCase.id);
  const snapshotPath = path.join(caseDir, "dogfood-snapshot.json");
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const result = evaluateScriptedDogfoodCase(evalCase, snapshot);
  const reportPath = path.join(reportRoot, `${dogfoodRunId}-summary.md`);
  return {
    ...result,
    artifacts: {
      ...(result.artifacts ?? {}),
      snapshot: snapshotPath,
      dogfoodReport: reportPath,
    },
  };
}

async function runJudgeCase(
  evalCase: LlmJudgeEvalCase,
  context: { args: CliArgs; runId: string; outDir: string },
): Promise<EvalCaseResult> {
  if (context.args["run-judge"] !== true) {
    return skippedEvalCase(evalCase, "LLM judge is opt-in; pass --run-judge to spend model tokens.");
  }

  const dogfoodRunId = context.args["dogfood-run-id"] ?? evalCase.dogfoodRunId;
  if (!dogfoodRunId) return skippedEvalCase(evalCase, "No dogfood run id was provided for the judge packet.");

  const reportRoot = path.resolve(context.args["dogfood-report-dir"] ?? DEFAULT_DOGFOOD_REPORT_ROOT);
  const runDir = path.resolve(context.args["dogfood-run-dir"] ?? path.join(reportRoot, dogfoodRunId));
  if (!(await exists(runDir))) return skippedEvalCase(evalCase, `Dogfood run dir does not exist: ${runDir}`);

  const caseDir = await ensureCaseDir(context.outDir, evalCase.id);
  const configResult = await resolveJudgeConfig({ cwd: process.cwd(), env: process.env });
  const configPath = path.join(caseDir, "judge-config.redacted.json");
  await writeFile(configPath, `${JSON.stringify(configResult.redacted, null, 2)}\n`, "utf8");
  if (!configResult.config) {
    return {
      id: evalCase.id,
      type: evalCase.type,
      status: "skipped",
      findings: [],
      skippedReason: `Judge config is incomplete: ${configResult.redacted.missing.join("; ")}`,
      artifacts: { redactedConfig: configPath },
    };
  }

  const snapshot = await loadDogfoodSnapshot({ dogfoodRunId, runDir });
  const manifest = await loadManifestIfPresent(path.join(runDir, "vault", ".dogfood", "manifest.json"));
  const packet = await buildJudgePacket({
    caseId: evalCase.id,
    dogfoodRunId,
    runDir,
    snapshot,
    manifest,
  });
  const packetPath = path.join(caseDir, "judge-packet.json");
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

  const cacheDir = path.resolve(context.args["judge-cache-dir"] ?? path.join(DEFAULT_OUT_ROOT, "judge-cache"));
  try {
    const judge = await runJudge({ config: configResult.config, packet, cacheDir });
    const resultPath = path.join(caseDir, "judge-result.json");
    await writeFile(resultPath, `${JSON.stringify(redactJudgeRunResult(judge), null, 2)}\n`, "utf8");
    return evaluateJudgeResult(evalCase, judge, {
      redactedConfig: configPath,
      packet: packetPath,
      judgeResult: resultPath,
      cacheDir,
    });
  } catch (error) {
    return {
      id: evalCase.id,
      type: evalCase.type,
      status: "problem",
      findings: [
        {
          severity: "error",
          caseId: evalCase.id,
          area: "llm-judge",
          message: `Judge run failed: ${errorMessage(error)}`,
        },
      ],
      artifacts: {
        redactedConfig: configPath,
        packet: packetPath,
        cacheDir,
      },
    };
  }
}

async function loadManifestIfPresent(manifestPath: string): Promise<DogfoodManifest | undefined> {
  return (await exists(manifestPath)) ? await loadDogfoodManifest(manifestPath) : undefined;
}

function evaluateJudgeResult(
  evalCase: LlmJudgeEvalCase,
  judge: JudgeRunResult,
  artifacts: Record<string, string>,
): EvalCaseResult {
  const minOverallScore = evalCase.minOverallScore ?? 4;
  const minDimensionScore = evalCase.minDimensionScore ?? 3;
  const findings = [];
  if (judge.verdict.overallScore < minOverallScore) {
    findings.push({
      severity: "warning" as const,
      caseId: evalCase.id,
      area: "llm-judge",
      message: `Judge overall score ${judge.verdict.overallScore} is below threshold ${minOverallScore}.`,
      details: { summary: judge.verdict.summary, issues: judge.verdict.issues, promptRecommendations: judge.verdict.promptRecommendations },
    });
  }
  const lowScores = Object.entries(judge.verdict.scores).filter(([, score]) => score < minDimensionScore);
  if (lowScores.length > 0) {
    findings.push({
      severity: "warning" as const,
      caseId: evalCase.id,
      area: "llm-judge",
      message: `Judge dimension score(s) below threshold ${minDimensionScore}: ${lowScores.map(([name]) => name).join(", ")}.`,
      details: { lowScores: Object.fromEntries(lowScores), issues: judge.verdict.issues, promptRecommendations: judge.verdict.promptRecommendations },
    });
  }
  if (!judge.verdict.pass) {
    findings.push({
      severity: "warning" as const,
      caseId: evalCase.id,
      area: "llm-judge",
      message: "Judge marked the run as not passing.",
      details: { summary: judge.verdict.summary, issues: judge.verdict.issues, promptRecommendations: judge.verdict.promptRecommendations },
    });
  }
  return {
    id: evalCase.id,
    type: evalCase.type,
    status: findings.length > 0 ? "problem" : "pass",
    findings,
    metrics: {
      cacheHit: judge.cacheHit,
      overallScore: judge.verdict.overallScore,
      pass: judge.verdict.pass,
      scores: judge.verdict.scores,
      issueCount: judge.verdict.issues.length,
      promptRecommendationCount: judge.verdict.promptRecommendations.length,
    },
    artifacts,
  };
}

function redactJudgeRunResult(judge: JudgeRunResult): Omit<JudgeRunResult, "rawResponse"> & { rawResponse: string } {
  return { ...judge, rawResponse: judge.rawResponse };
}

function runDogfoodE2e(options: {
  evalCase: ScriptedDogfoodEvalCase;
  dogfoodRunId: string;
  runDir: string;
  reportRoot: string;
}): Promise<number> {
  const dogfoodArgs = [
    "run",
    "test:e2e:dogfood",
    "--",
    "--run-id",
    options.dogfoodRunId,
    "--report-dir",
    options.reportRoot,
    "--run-dir",
    options.runDir,
  ];
  if (options.evalCase.dogfood?.spec) dogfoodArgs.push("--spec", options.evalCase.dogfood.spec);
  if (options.evalCase.dogfood?.timeoutMs) dogfoodArgs.push("--timeout-ms", String(options.evalCase.dogfood.timeoutMs));
  if (options.evalCase.dogfood?.turnTimeoutMs) {
    dogfoodArgs.push("--turn-timeout-ms", String(options.evalCase.dogfood.turnTimeoutMs));
  }

  return new Promise((resolve) => {
    const child = spawn(npmCommand(), dogfoodArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        NO_PROXY: mergeNoProxy(process.env.NO_PROXY),
      },
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      process.stderr.write(`Failed to launch dogfood E2E: ${error.message}\n`);
      resolve(1);
    });
  });
}

async function loadSessionAnalyzer(): Promise<AnalyzeSessionModule> {
  const moduleUrl = pathToFileURL(path.resolve("scripts/analyze-session-trace.mjs")).href;
  return (await import(moduleUrl)) as AnalyzeSessionModule;
}

async function ensureCaseDir(outDir: string, caseId: string): Promise<string> {
  const caseDir = path.join(outDir, slug(caseId));
  await mkdir(caseDir, { recursive: true });
  return caseDir;
}

function selectCases(suite: EvalSuite, caseId: string | undefined): AgenticEvalCase[] {
  if (!caseId) return suite.cases;
  const selected = suite.cases.filter((evalCase) => evalCase.id === caseId);
  if (selected.length === 0) throw new Error(`No eval case found with id: ${caseId}`);
  return selected;
}

function totals(results: EvalCaseResult[]): EvalRunSummary["totals"] {
  const findings = results.flatMap((result) => result.findings);
  return {
    cases: results.length,
    passed: results.filter((result) => result.status === "pass").length,
    problems: results.filter((result) => result.status === "problem").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
  };
}

function formatSummary(summary: EvalRunSummary): string {
  const lines = [
    `# Agentic Eval Run ${summary.runId}`,
    "",
    `Suite: ${summary.suite.name}`,
    `Started: ${summary.startedAt}`,
    `Finished: ${summary.finishedAt}`,
    `Duration ms: ${summary.durationMs}`,
    "",
    "## Totals",
    `- Cases: ${summary.totals.cases}`,
    `- Passed: ${summary.totals.passed}`,
    `- Problems: ${summary.totals.problems}`,
    `- Skipped: ${summary.totals.skipped}`,
    `- Errors: ${summary.totals.errors}`,
    `- Warnings: ${summary.totals.warnings}`,
    "",
    "## Cases",
  ];
  for (const result of summary.results) {
    lines.push("", `### ${result.id}`, "", `Status: ${result.status}`);
    if (result.skippedReason) lines.push(`Skipped: ${result.skippedReason}`);
    if (result.artifacts) {
      lines.push("", "Artifacts:");
      for (const [name, artifactPath] of Object.entries(result.artifacts)) lines.push(`- ${name}: ${artifactPath}`);
    }
    if (result.findings.length > 0) {
      lines.push("", "Findings:");
      for (const finding of result.findings) {
        lines.push(`- ${finding.severity.toUpperCase()} [${finding.area}] ${finding.message}`);
        if (finding.details !== undefined) lines.push(`  Details: ${JSON.stringify(finding.details)}`);
      }
    } else {
      lines.push("", "Findings:", "- none");
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatConsoleSummary(summary: EvalRunSummary, summaryMdPath: string, summaryJsonPath: string): string {
  const findings = summary.results.flatMap((result) => result.findings);
  const lines = [
    `Agentic eval run: ${summary.runId}`,
    `Summary: ${summaryMdPath}`,
    `JSON: ${summaryJsonPath}`,
    `Findings: ${summary.totals.errors} error(s), ${summary.totals.warnings} warning(s)`,
  ];
  for (const finding of findings.slice(0, 12)) {
    lines.push(`- ${finding.severity.toUpperCase()} ${finding.caseId} [${finding.area}] ${finding.message}`);
  }
  if (findings.length > 12) lines.push(`- ... ${findings.length - 12} more finding(s) in summary.md`);
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: Record<string, string | boolean> = {};
  const booleanFlags = new Set(["run-scripted", "run-judge", "allow-problems", "expect-problems", "strict"]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) throw new Error(`Unexpected argument: ${raw}`);
    const key = raw.slice(2);
    if (booleanFlags.has(key)) {
      parsed[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed as CliArgs;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "case";
}

function timestampRunId(): string {
  return `agentic-eval-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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
