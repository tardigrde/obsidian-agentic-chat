import { $, browser } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BudgetTracker,
  type RunPricing,
  type RunUsage,
  type ToolUseBudgetCaps,
  type ToolUseCheckResult,
} from "../../../scripts/eval/tool-use-core";
import { readLatestSessionRaw, sendPrompt, waitForTurnEnd } from "../dogfood/dogfood-helpers";

const PLAN_PATH = process.env.TOOL_USE_PLAN?.trim() ?? "";
const RESULTS_DIR = process.env.TOOL_USE_RESULTS_DIR?.trim() ?? "";
const PLUGIN_ID = "agentic-chat";

interface EvalCasePlan {
  id: string;
  prompt: string;
  seed: { files: Record<string, string> };
  settings?: Record<string, string | number | boolean>;
  checks: unknown[];
}

interface EvalPlan {
  runId: string;
  model: string;
  runsPerCase: number;
  budget: ToolUseBudgetCaps;
  turn: { timeoutMs: number; maxTurnsPerPrompt: number };
  prices: RunPricing;
  cases: EvalCasePlan[];
  runs: Array<{ caseId: string; run: number }>;
}

interface ObservedSession {
  toolCalls: Array<{ name: string; isError?: boolean }>;
  answer: string;
  usage: RunUsage;
  modelCalls: number;
}

interface RunResult extends ObservedSession {
  caseId: string;
  run: number;
  files: Record<string, string>;
  frontmatter: Record<string, Record<string, unknown>>;
  ms: number;
  status?: string;
  error?: string;
  checks?: ToolUseCheckResult[];
}

interface AnalyzerModule {
  analyzeSessionText: (text: string, file?: string) => {
    files: Array<{
      toolCalls?: Array<{ name: string; isError?: boolean }>;
      finalAssistantText?: string;
    }>;
    aggregate: {
      usage?: RunUsage;
      messages?: { assistant?: number };
    };
  };
}

let plan: EvalPlan;
let analyzer: AnalyzerModule;

describe("tool-use eval", function () {
  before(async function () {
    if (!PLAN_PATH) this.skip();
    if (!RESULTS_DIR) throw new Error("TOOL_USE_RESULTS_DIR is required");
    plan = JSON.parse(readFileSync(PLAN_PATH, "utf8")) as EvalPlan;
    if (!plan.prices) throw new Error("The tool-use plan has no fetched prices");
    analyzer = (await import(
      pathToFileURL(path.join(process.cwd(), "scripts/analyze-session-trace.mjs")).href
    )) as AnalyzerModule;
    await openChat();
    await configurePlugin();
  });

  it("runs every planned case run and records its observation", async function () {
    for (const planned of plan.runs) {
      const evalCase = plan.cases.find((entry) => entry.id === planned.caseId);
      if (!evalCase) throw new Error(`Plan refers to an unknown case: ${planned.caseId}`);

      await stopIfRunning();
      await closeModals();
      const exceeded = budgetExceeded();
      if (exceeded) {
        writeResult({
          caseId: evalCase.id,
          run: planned.run,
          files: {},
          frontmatter: {},
          toolCalls: [],
          answer: "",
          usage: {},
          modelCalls: 0,
          ms: 0,
          status: "skipped-budget",
          error: exceeded,
        });
        continue;
      }

      const startedAt = Date.now();
      try {
        await prepareVault(evalCase.seed.files);
        await applyCaseSettings(evalCase.settings ?? {});
        await browser.executeObsidianCommand("agentic-chat:new-conversation");
        await $(".agentic-chat-empty").waitForExist({ timeout: 10_000 });
        await sendPrompt(evalCase.prompt);
        // waitForTurnEnd passes while Stop is still hidden, so first wait for this
        // run's assistant bubble (the transcript was empty after new-conversation).
        await $(".agentic-chat-assistant").waitForExist({ timeout: 30_000 });
        await waitForTurnEnd(plan.turn.timeoutMs);

        const ms = Date.now() - startedAt;
        const files = await readVaultMarkdown();
        const frontmatter = await readVaultFrontmatter();
        const observation = await readObservation();
        writeResult({ caseId: evalCase.id, run: planned.run, files, frontmatter, ...observation, ms });
      } catch (error) {
        const ms = Date.now() - startedAt;
        await stopIfRunning();
        let files: Record<string, string> = {};
        const frontmatter: Record<string, Record<string, unknown>> = {};
        let observation = emptyObservation();
        try {
          files = await readVaultMarkdown();
        } catch {
          // Keep the empty map; the runner will fail the checks.
        }
        try {
          observation = await readObservation();
        } catch {
          // Keep the empty observation.
        }
        writeResult({
          caseId: evalCase.id,
          run: planned.run,
          files,
          frontmatter,
          ...observation,
          ms,
          error: errorMessage(error),
        });
      }
    }
  });
});

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

async function configurePlugin(): Promise<void> {
  const apiKey = process.env.AGENTIC_CHAT_API_KEY?.trim();
  if (!apiKey) throw new Error("AGENTIC_CHAT_API_KEY is missing for the tool-use eval spec");
  const configured = await browser.executeObsidian(async ({ app }, config) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<
          string,
          { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }
        >;
      };
    }).plugins?.plugins?.[config.pluginId];
    if (!plugin?.settings) return false;
    const settings = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      openrouterModel: string;
      temperature: number;
      mode: string;
      maxTurnsPerPrompt: number;
      ignoredGlobs: string;
      approval: { mutating: string; perTool: Record<string, string> };
      web: { enabled: boolean };
      mcp: { enabled: boolean };
      toolBudget: { enabled: boolean };
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = config.apiKey;
    settings.openrouterModel = config.model;
    settings.temperature = 0;
    settings.mode = "safe";
    settings.approval.mutating = "allow";
    settings.approval.perTool = {};
    settings.web.enabled = false;
    settings.mcp.enabled = false;
    settings.toolBudget.enabled = false;
    settings.maxTurnsPerPrompt = config.maxTurnsPerPrompt;
    settings.ignoredGlobs = "";
    await plugin.saveSettings?.();
    return true;
  }, { pluginId: PLUGIN_ID, apiKey, model: plan.model, maxTurnsPerPrompt: plan.turn.maxTurnsPerPrompt });
  if (!configured) throw new Error("agentic-chat plugin not found in the tool-use vault");
}

async function applyCaseSettings(settings: Record<string, string | number | boolean>): Promise<void> {
  await browser.executeObsidian(async ({ app }, caseSettings) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<
          string,
          { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }
        >;
      };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings;
    settings.ignoredGlobs = "";
    for (const [key, value] of Object.entries(caseSettings)) settings[key] = value;
    await plugin.saveSettings?.();
  }, settings);
}

async function prepareVault(seedFiles: Record<string, string>): Promise<void> {
  await browser.executeObsidian(async ({ app }, files) => {
    for (const child of [...app.vault.getRoot().children]) {
      if (child.path === app.vault.configDir) continue;
      await app.vault.delete(child, true);
    }

    const folders = new Set<string>();
    for (const filePath of Object.keys(files)) {
      const parts = filePath.split("/");
      for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join("/"));
    }
    for (const folder of [...folders].sort((left, right) => left.length - right.length)) {
      if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
    }
    for (const [filePath, content] of Object.entries(files)) {
      await app.vault.create(filePath, content);
    }
  }, seedFiles);
}

async function readVaultMarkdown(): Promise<Record<string, string>> {
  return await browser.executeObsidian(async ({ app }) => {
    const files: Record<string, string> = {};
    for (const file of app.vault.getMarkdownFiles()) files[file.path] = await app.vault.read(file);
    return files;
  });
}

async function readVaultFrontmatter(): Promise<Record<string, Record<string, unknown>>> {
  return await browser.executeObsidian(async ({ app }) => {
    const files = app.vault.getMarkdownFiles();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !files.every((file) => app.metadataCache.getFileCache(file))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const frontmatter: Record<string, Record<string, unknown>> = {};
    for (const file of files) {
      const entry = app.metadataCache.getFileCache(file)?.frontmatter;
      if (!entry) continue;
      const copy: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (key === "position") continue;
        copy[key] = value;
      }
      frontmatter[file.path] = copy;
    }
    return frontmatter;
  });
}

async function readObservation(): Promise<ObservedSession> {
  const raw = await readSessionRaw();
  if (!raw.trim()) return emptyObservation();
  const analysis = analyzer.analyzeSessionText(raw);
  const file = analysis.files[0];
  return {
    toolCalls: file?.toolCalls ?? [],
    answer: file?.finalAssistantText ?? "",
    usage: analysis.aggregate.usage ?? {},
    modelCalls: analysis.aggregate.messages?.assistant ?? 0,
  };
}

async function readSessionRaw(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = await readLatestSessionRaw();
    if (raw.trim()) return raw;
    await browser.pause(200);
  }
  return "";
}

function emptyObservation(): ObservedSession {
  return { toolCalls: [], answer: "", usage: {}, modelCalls: 0 };
}

// The budget spans the WDIO process boundary: every completed run is already on
// disk, so re-reading all results before the next run sees the true total.
function budgetExceeded(): string | null {
  const tracker = new BudgetTracker(plan.budget, plan.prices);
  for (const result of existingResults()) {
    if (result.status === "skipped-budget") continue;
    tracker.add({ usage: result.usage ?? {}, modelCalls: result.modelCalls ?? 1 });
  }
  return tracker.exceeded();
}

function existingResults(): Array<Partial<RunResult>> {
  if (!existsSync(RESULTS_DIR)) return [];
  const results: Array<Partial<RunResult>> = [];
  for (const entry of readdirSync(RESULTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const caseDir = path.join(RESULTS_DIR, entry.name);
    for (const filename of readdirSync(caseDir)) {
      if (!filename.endsWith(".json")) continue;
      try {
        results.push(JSON.parse(readFileSync(path.join(caseDir, filename), "utf8")) as Partial<RunResult>);
      } catch {
        // A partial file is not budget evidence; the runner reports it as missing.
      }
    }
  }
  return results;
}

function writeResult(result: RunResult): void {
  const caseDir = path.join(RESULTS_DIR, result.caseId);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(path.join(caseDir, `${result.run}.json`), `${JSON.stringify(result, null, 2)}\n`);
}

async function stopIfRunning(): Promise<void> {
  const stop = await $(".agentic-chat-stop");
  if (!(await stop.isDisplayed().catch(() => false))) return;
  await stop.click().catch(() => undefined);
  await browser
    .waitUntil(async () => !(await stop.isDisplayed().catch(() => false)), {
      timeout: 10_000,
      timeoutMsg: "tool-use turn did not stop",
    })
    .catch(() => undefined);
}

/** A modal left open by a run (for example a confirm dialog) blocks the next one. */
async function closeModals(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await browser.execute(() => document.querySelectorAll(".modal-container").length);
    if (open === 0) return;
    await browser.keys("Escape");
    await browser.pause(200);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
