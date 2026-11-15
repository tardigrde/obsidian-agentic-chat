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
import { sendPrompt } from "../dogfood/dogfood-helpers";

const PLAN_PATH = process.env.TOOL_USE_PLAN?.trim() ?? "";
const RESULTS_DIR = process.env.TOOL_USE_RESULTS_DIR?.trim() ?? "";
const PLUGIN_ID = "agentic-chat";

interface EvalCasePlan {
  id: string;
  prompt: string;
  seed: { files: Record<string, string>; binaryFiles?: Record<string, string> };
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
  links: Record<string, string[]>;
  unresolvedLinks: Record<string, string[]>;
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
let baseCaseSettings: Record<string, unknown> = {};

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

      // A turn that will not stop must fail the spec: seeding the next vault
      // under a live turn lets the model write into the next run.
      await stopIfRunning();
      await closeModals();
      await openChatIfNeeded();
      const exceeded = budgetExceeded();
      if (exceeded) {
        writeResult({
          caseId: evalCase.id,
          run: planned.run,
          files: {},
          frontmatter: {},
          links: {},
          unresolvedLinks: {},
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
      let sessionBaseline: string[] | undefined;
      try {
        await prepareVault(evalCase.seed.files, evalCase.seed.binaryFiles ?? {});
        await applyCaseSettings(evalCase.settings ?? {});
        // The command callback is fire-and-forget, so take the set before it
        // starts. The new session file is the only one that may appear.
        sessionBaseline = await listSessionPaths();
        await browser.executeObsidianCommand("agentic-chat:new-conversation");
        await $(".agentic-chat-empty").waitForExist({ timeout: 30_000 });
        await sendPrompt(evalCase.prompt);
        // waitForTurnEnd passes while Stop is still hidden, so first wait for this
        // run's assistant bubble (the transcript was empty after new-conversation).
        // A slow provider can take more than 30 s to start the turn.
        await $(".agentic-chat-assistant").waitForExist({ timeout: 60_000 });
        // An open ask-user card means the turn waits for a human. Treat it as
        // the end for this run, then stop the turn so the next run starts clean.
        await waitForTurnOrAskUser(plan.turn.timeoutMs);
        await closeModals();
        await stopIfRunning();

        const ms = Date.now() - startedAt;
        const files = await readVaultMarkdown();
        const frontmatter = await readVaultFrontmatter();
        const { links, unresolvedLinks } = await readVaultLinks();
        const observation = await readObservation(sessionBaseline);
        writeResult({
          caseId: evalCase.id,
          run: planned.run,
          files,
          frontmatter,
          links,
          unresolvedLinks,
          ...observation,
          ms,
        });
      } catch (error) {
        const ms = Date.now() - startedAt;
        try {
          await closeModals();
          await stopIfRunning();
        } catch {
          // A dead WebDriver session cannot be cleaned up. Keep the primary
          // error: the runner reports the missing observation, and the next
          // run starts from a fresh session.
        }
        let files: Record<string, string> = {};
        const frontmatter: Record<string, Record<string, unknown>> = {};
        let links: Record<string, string[]> = {};
        let unresolvedLinks: Record<string, string[]> = {};
        let observation = emptyObservation();
        try {
          files = await readVaultMarkdown();
        } catch {
          // Keep the empty map; the runner will fail the checks.
        }
        try {
          ({ links, unresolvedLinks } = await readVaultLinks());
        } catch {
          // Keep the empty maps; the runner will fail the checks.
        }
        if (sessionBaseline) {
          try {
            observation = await readObservation(sessionBaseline);
          } catch {
            // Keep the empty observation.
          }
        }
        writeResult({
          caseId: evalCase.id,
          run: planned.run,
          files,
          frontmatter,
          links,
          unresolvedLinks,
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

/** A settings popout or a closed tab can leave the chat view gone; reopen it. */
async function openChatIfNeeded(): Promise<void> {
  if (await $(".agentic-chat-view").isExisting().catch(() => false)) return;
  await openChat();
}

async function configurePlugin(): Promise<void> {
  const apiKey = process.env.AGENTIC_CHAT_API_KEY?.trim();
  if (!apiKey) throw new Error("AGENTIC_CHAT_API_KEY is missing for the tool-use eval spec");
  const settingKeys = [...new Set(plan.cases.flatMap((entry) => Object.keys(entry.settings ?? {})))];
  const configured = await browser.executeObsidian(async ({ app }, config) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<
          string,
          { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }
        >;
      };
    }).plugins?.plugins?.[config.pluginId];
    if (!plugin?.settings) return null;
    const settings = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      openrouterModel: string;
      temperature: number;
      mode: string;
      maxTurnsPerPrompt: number;
      ignoredGlobs: string;
      approval: { mutating: string; perTool: Record<string, string> };
      privacy: { allowFallbacks: boolean; denyDataCollection: boolean; requireZDR: boolean };
      web: { enabled: boolean };
      mcp: { enabled: boolean };
      toolBudget: { enabled: boolean };
      maxTokens: number;
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = config.apiKey;
    settings.openrouterModel = config.model;
    settings.temperature = 0;
    settings.mode = "safe";
    settings.approval.mutating = "allow";
    // The eval vault is synthetic. Recursive deletes still ask even under a
    // blanket allow, and the approval modal would block the stop button and
    // hang the turn. A per-tool allow lets the run finish; the checks, not a
    // modal, decide whether the delete was right.
    settings.approval.perTool = { delete: "allow" };
    // The eval vault is synthetic and holds no private data, so provider
    // privacy filters add routing noise without protecting anything. Pin one
    // provider path so a fallback or a ZDR filter does not move the score.
    settings.privacy.allowFallbacks = false;
    settings.privacy.denyDataCollection = false;
    settings.privacy.requireZDR = false;
    settings.web.enabled = false;
    settings.mcp.enabled = false;
    settings.toolBudget.enabled = false;
    // A provider reserves the request's max output tokens against the key's
    // credit. The 24-case runs never need more than a few thousand output
    // tokens, so cap it and leave the key budget for the whole baseline.
    settings.maxTokens = 8192;
    settings.maxTurnsPerPrompt = config.maxTurnsPerPrompt;
    settings.ignoredGlobs = "";
    const settingsRecord = settings as unknown as Record<string, unknown>;
    const base: Record<string, unknown> = {};
    for (const key of config.settingKeys) base[key] = settingsRecord[key];
    await plugin.saveSettings?.();
    return { base };
  }, {
    pluginId: PLUGIN_ID,
    apiKey,
    model: plan.model,
    maxTurnsPerPrompt: plan.turn.maxTurnsPerPrompt,
    settingKeys,
  });
  if (!configured) throw new Error("agentic-chat plugin not found in the tool-use vault");
  baseCaseSettings = configured.base;
}

async function applyCaseSettings(settings: Record<string, string | number | boolean>): Promise<void> {
  await browser.executeObsidian(async ({ app }, payload) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<
          string,
          { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }
        >;
      };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const current = plugin.settings;
    for (const [key, value] of Object.entries(payload.base)) current[key] = value;
    for (const [key, value] of Object.entries(payload.caseSettings)) current[key] = value;
    await plugin.saveSettings?.();
  }, { base: baseCaseSettings, caseSettings: settings });
}

async function prepareVault(
  seedFiles: Record<string, string>,
  binaryFiles: Record<string, string>,
): Promise<void> {
  await browser.executeObsidian(async ({ app }, seed) => {
    for (const child of [...app.vault.getRoot().children]) {
      if (child.path === app.vault.configDir) continue;
      await app.vault.delete(child, true);
    }

    const folders = new Set<string>();
    for (const filePath of [...Object.keys(seed.files), ...Object.keys(seed.binaryFiles)]) {
      const parts = filePath.split("/");
      for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join("/"));
    }
    for (const folder of [...folders].sort((left, right) => left.length - right.length)) {
      if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
    }
    for (const [filePath, content] of Object.entries(seed.files)) {
      await app.vault.create(filePath, content);
    }
    for (const [filePath, base64] of Object.entries(seed.binaryFiles)) {
      const bytes = Uint8Array.from(atob(base64.replace(/\s+/g, "")), (char) => char.charCodeAt(0));
      await app.vault.createBinary(filePath, bytes.buffer);
    }
  }, { files: seedFiles, binaryFiles });
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

async function readVaultLinks(): Promise<{
  links: Record<string, string[]>;
  unresolvedLinks: Record<string, string[]>;
}> {
  return await browser.executeObsidian(async ({ app }) => {
    const files = app.vault.getMarkdownFiles();
    const readSnapshot = () => {
      const resolvedLinks = app.metadataCache.resolvedLinks as Record<string, Record<string, number>>;
      const unresolvedBySource = app.metadataCache.unresolvedLinks as Record<string, Record<string, number>>;
      const ready = files.every((file) => app.metadataCache.getFileCache(file));
      const links: Record<string, string[]> = {};
      const unresolvedLinks: Record<string, string[]> = {};
      for (const file of files) {
        links[file.path] = Object.keys(resolvedLinks[file.path] ?? {});
        const targets = Object.keys(unresolvedBySource[file.path] ?? {});
        if (targets.length > 0) unresolvedLinks[file.path] = targets;
      }
      return { ready, links, unresolvedLinks, key: JSON.stringify({ links, unresolvedLinks }) };
    };

    // Obsidian resolves links after the turn, so a single read can catch a
    // partial cache. Accept only a ready snapshot that equals the previous
    // read, and fall back to the last read after 5 s.
    const deadline = Date.now() + 5_000;
    let previousKey: string | undefined;
    let last = readSnapshot();
    while (true) {
      if (last.ready && previousKey === last.key) break;
      if (Date.now() >= deadline) break;
      previousKey = last.ready ? last.key : undefined;
      await new Promise((resolve) => setTimeout(resolve, 250));
      last = readSnapshot();
    }
    return { links: last.links, unresolvedLinks: last.unresolvedLinks };
  });
}

async function readObservation(sessionBaseline: string[]): Promise<ObservedSession> {
  const raw = await readNewSessionRaw(sessionBaseline);
  const apiError = sessionApiError(raw);
  if (apiError) throw new Error(`model request failed: ${apiError}`);
  const analysis = analyzer.analyzeSessionText(raw);
  const file = analysis.files[0];
  return {
    toolCalls: file?.toolCalls ?? [],
    answer: file?.finalAssistantText ?? "",
    usage: analysis.aggregate.usage ?? {},
    modelCalls: analysis.aggregate.messages?.assistant ?? 0,
  };
}

/** A provider 402/429 is a run error, not an empty answer. The trace keeps it on the assistant message. */
function sessionApiError(raw: string): string | undefined {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { message?: { stopReason?: string; errorMessage?: string } };
      if (entry.message?.stopReason === "error") return entry.message.errorMessage ?? "unknown provider error";
    } catch {
      return "the session trace is not valid JSON";
    }
  }
  return undefined;
}

/** Read the one session file this run's new-conversation created. */
async function readNewSessionRaw(sessionBaseline: string[]): Promise<string> {
  const before = new Set(sessionBaseline);
  const deadline = Date.now() + 5_000;
  let added: string[] = [];
  while (Date.now() < deadline) {
    added = (await listSessionPaths()).filter((sessionPath) => !before.has(sessionPath));
    if (added.length > 1) {
      throw new Error(`Expected exactly one new session file, found ${added.length}: ${added.join(", ")}`);
    }
    if (added.length === 1) {
      const raw = await readSessionFileRaw(added[0]);
      if (hasAssistantMessage(raw)) return raw;
    }
    await browser.pause(100);
  }
  if (added.length !== 1) {
    throw new Error(
      `Expected exactly one new session file after this run, found ${added.length}` +
        (added.length > 0 ? `: ${added.join(", ")}` : ""),
    );
  }
  throw new Error(`The new session ${added[0]} did not get an assistant message within 5 s`);
}

async function listSessionPaths(): Promise<string[]> {
  return await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { manifest?: { dir?: string } }> };
    }).plugins?.plugins?.["agentic-chat"];
    const pluginDir = plugin?.manifest?.dir ?? `${app.vault.configDir}/plugins/agentic-chat`;
    const sessionsDir = `${pluginDir}/sessions`;
    const adapter = app.vault.adapter;
    if (!(await adapter.exists(sessionsDir))) return [];
    const listing = await adapter.list(sessionsDir);
    return listing.files.filter((file) => file.endsWith(".jsonl"));
  });
}

async function readSessionFileRaw(sessionPath: string): Promise<string> {
  return await browser.executeObsidian(async ({ app }, target) => {
    return await app.vault.adapter.read(target);
  }, sessionPath);
}

function hasAssistantMessage(raw: string): boolean {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
      if (entry.type === "message" && entry.message?.role === "assistant") return true;
    } catch {
      return false;
    }
  }
  return false;
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
    tracker.add({ usage: result.usage ?? {}, modelCalls: result.modelCalls ?? 0 });
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

/**
 * `waitForTurnEnd` waits for an open ask-user card to close, but an eval run
 * cannot answer it. Stop at the card and let the checks grade the tool call.
 */
async function waitForTurnOrAskUser(timeoutMs: number): Promise<void> {
  await browser.waitUntil(
    async () => {
      const stopVisible = await $(".agentic-chat-stop").isDisplayed().catch(() => false);
      const askUserOpen = await $(".agentic-chat-ask-user").isExisting().catch(() => false);
      return askUserOpen || !stopVisible;
    },
    { timeout: timeoutMs, timeoutMsg: "turn did not finish" },
  );
}

async function stopIfRunning(): Promise<void> {
  const stop = await $(".agentic-chat-stop");
  if (!(await stop.isDisplayed().catch(() => false))) return;
  try {
    await stop.click();
  } catch (error) {
    throw new Error(`tool-use turn did not stop: the stop button click failed (${errorMessage(error)})`, {
      cause: error,
    });
  }
  try {
    await browser.waitUntil(async () => !(await stop.isDisplayed().catch(() => false)), {
      timeout: 10_000,
      timeoutMsg: "tool-use turn did not stop",
    });
  } catch (error) {
    throw new Error(`tool-use turn did not stop within 10 s (${errorMessage(error)})`, { cause: error });
  }
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
