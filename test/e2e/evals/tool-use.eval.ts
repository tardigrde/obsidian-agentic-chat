import { $, browser } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { BudgetTracker, type ObservedRun, type RunUsage, type ToolUseCase } from "../../../scripts/eval/tool-use-core";
import {
  emptyObservation,
  type PlannedRun,
  type RunRecord,
  type ToolUsePlan,
} from "../../../scripts/eval/tool-use-plan";
import type { McpServerSettings } from "../../../src/mcp/settings";
import { sendPrompt } from "../dogfood/dogfood-helpers";

/**
 * Executes the plan that `scripts/run-tool-use-evals.ts` wrote: one fresh
 * vault and one new conversation per planned run. The spec only observes; it
 * writes one run record per run and the runner grades them.
 */

const PLAN_PATH = process.env.TOOL_USE_PLAN?.trim() ?? "";
const RESULTS_DIR = process.env.TOOL_USE_RESULTS_DIR?.trim() ?? "";
const PLUGIN_ID = "agentic-chat";
/** The metadata cache and the session file settle shortly after the turn. */
const SETTLE_TIMEOUT_MS = 5_000;

type SessionObservation = Pick<ObservedRun, "toolCalls" | "answer"> & {
  usage: RunUsage;
  modelCalls: number;
  observedThinkingLevel?: string;
};
type VaultObservation = Omit<ObservedRun, "toolCalls" | "answer">;

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

interface SessionEntry {
  type?: string;
  thinkingLevel?: unknown;
  message?: {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: { totalTokens?: unknown; cost?: { total?: unknown; totalFromProvider?: unknown } };
  };
}

let plan: ToolUsePlan;
let analyzer: AnalyzerModule;
/** The top-level settings objects that a case may override, as configured for the eval. */
let baseSettings: Record<string, unknown> = {};

describe("tool-use eval", function () {
  before(async function () {
    if (!PLAN_PATH) this.skip();
    if (!RESULTS_DIR) throw new Error("TOOL_USE_RESULTS_DIR is required");
    plan = JSON.parse(readFileSync(PLAN_PATH, "utf8")) as ToolUsePlan;
    analyzer = (await import(
      pathToFileURL(path.join(process.cwd(), "scripts/analyze-session-trace.mjs")).href
    )) as AnalyzerModule;
    await installFixtureOrigin(plan.fixtureBaseUrl);
    await openChat();
    baseSettings = await configurePlugin();
  });

  it("runs every planned case run and records its observation", async function () {
    const caseById = new Map(plan.cases.map((evalCase) => [evalCase.id, evalCase]));
    // The runner starts every run id with an empty results directory, so the
    // records this process writes are the whole spend.
    const budget = new BudgetTracker(plan.budget, plan.prices);

    for (const planned of plan.runs) {
      const evalCase = caseById.get(planned.caseId);
      if (!evalCase) throw new Error(`Plan refers to an unknown case: ${planned.caseId}`);

      // A turn that will not stop must fail the spec: seeding the next vault
      // under a live turn lets the model write into the next run.
      await endTurn();
      await openChatIfNeeded();

      const exceeded = budget.exceeded();
      const record = exceeded ? skippedRecord(planned, exceeded) : await executeRun(evalCase, planned);
      budget.add(record);
      writeRecord(record);
    }
  });
});

/**
 * Drive one run and observe it. A harness failure does not throw: the record
 * keeps the error next to whatever could still be observed, so the tokens the
 * run spent stay in the budget and the report shows what the vault looked like.
 */
async function executeRun(evalCase: ToolUseCase, planned: PlannedRun): Promise<RunRecord> {
  const startedAt = Date.now();
  let sessionBaseline: string[] | undefined;
  let error: string | undefined;
  try {
    await seedVault(evalCase.seed.files, evalCase.seed.binaryFiles);
    // The plan already resolved the per-case pin, so this is the level to use.
    await applyCaseSettings(evalCase.settings ?? {}, evalCase.thinkingLevel ?? plan.thinkingLevel);
    // The command callback is fire-and-forget, so take the set before it
    // starts. The new session file is the only one that may appear.
    sessionBaseline = await listSessionPaths();
    await browser.executeObsidianCommand("agentic-chat:new-conversation");
    await $(".agentic-chat-empty").waitForExist({ timeout: 30_000 });
    await sendPrompt(evalCase.prompt);
    // The turn-end wait passes while Stop is still hidden, so first wait for
    // this run's assistant bubble (the transcript was empty after
    // new-conversation). A slow provider can take more than 30 s to start.
    await $(".agentic-chat-assistant").waitForExist({ timeout: 60_000 });
    await waitForTurnOrAskUser(plan.turn.timeoutMs);
    await endTurn();
  } catch (caught) {
    error = errorMessage(caught);
    // A dead WebDriver session cannot be cleaned up. Keep the primary error;
    // the next run's own `endTurn` fails the spec if the turn is still live.
    await endTurn().catch(() => undefined);
  }
  const ms = Date.now() - startedAt;

  const vault = await observeVault().catch((caught: unknown) => {
    error ??= `could not read the vault: ${errorMessage(caught)}`;
    return emptyVaultObservation();
  });
  let session = emptySessionObservation();
  if (sessionBaseline) {
    try {
      const raw = await readNewSession(sessionBaseline);
      session = observeSession(raw);
      const apiError = sessionApiError(raw);
      if (apiError) error ??= `model request failed: ${apiError}`;
    } catch (caught) {
      error ??= errorMessage(caught);
    }
  }

  return {
    caseId: planned.caseId,
    run: planned.run,
    ms,
    usage: session.usage,
    modelCalls: session.modelCalls,
    ...(session.observedThinkingLevel ? { observedThinkingLevel: session.observedThinkingLevel } : {}),
    observed: { ...vault, toolCalls: session.toolCalls, answer: session.answer },
    ...(error ? { error } : {}),
  };
}

function skippedRecord(planned: PlannedRun, cap: string): RunRecord {
  return {
    caseId: planned.caseId,
    run: planned.run,
    ms: 0,
    usage: {},
    modelCalls: 0,
    observed: emptyObservation(),
    skippedBudget: cap,
  };
}

function writeRecord(record: RunRecord): void {
  const caseDir = path.join(RESULTS_DIR, record.caseId);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(path.join(caseDir, `${record.run}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

/** A settings popout or a closed tab can leave the chat view gone; reopen it. */
async function openChatIfNeeded(): Promise<void> {
  if (await $(".agentic-chat-view").isExisting().catch(() => false)) return;
  await openChat();
}

/**
 * Allow the plugin to reach the one loopback origin that this run's fixture
 * server owns. Only the e2e build reads the hook; a release build has no such
 * code. Unset, the SSRF gate keeps every local and private address blocked.
 */
async function installFixtureOrigin(baseUrl: string | undefined): Promise<void> {
  const origin = baseUrl ? new URL(baseUrl).origin : undefined;
  await browser.execute((fixtureOrigin) => {
    const target = globalThis as { __AGENTIC_CHAT_EVAL_FIXTURE_ORIGIN__?: string };
    if (fixtureOrigin) target.__AGENTIC_CHAT_EVAL_FIXTURE_ORIGIN__ = fixtureOrigin;
    else delete target.__AGENTIC_CHAT_EVAL_FIXTURE_ORIGIN__;
  }, origin);
}

/**
 * One user-owned MCP server that points at this run's fake MCP server. The spec
 * assigns raw settings, so every field the client reads must be present
 * (compare `test/e2e/specs/mcp-live.e2e.ts`). The MCP endpoint policy allows
 * plain http for loopback hosts, so no eval-only SSRF hook is needed here.
 * `approval: "allow"` matches the eval's blanket mutating allow: an "ask"
 * default would open a modal and block the turn.
 */
function fixtureMcpServer(url: string): McpServerSettings {
  return {
    id: "eval_fixture",
    name: "Eval fixture MCP",
    url,
    enabled: true,
    authType: "none",
    authHeaderName: "",
    authHeaderValueSecretId: "agentic-chat-mcp-eval-fixture-auth-header-value",
    authHeaderValue: "",
    oauth: {
      clientId: "",
      clientSecretSecretId: "agentic-chat-mcp-eval-fixture-oauth-client-secret",
      clientSecret: "",
      dynamicClientRegistration: false,
      registeredRedirectUri: "",
      authorizationServer: "",
      authorizationEndpoint: "",
      tokenEndpoint: "",
      registrationEndpoint: "",
      resourceMetadataUrl: "",
      accessTokenSecretId: "agentic-chat-mcp-eval-fixture-oauth-access-token",
      accessToken: "",
      refreshTokenSecretId: "agentic-chat-mcp-eval-fixture-oauth-refresh-token",
      refreshToken: "",
      expiresAt: 0,
      scope: "",
    },
    approval: "allow",
    knownTools: [],
    enabledTools: [],
    disabledTools: [],
    headers: {},
    source: "user",
  };
}

/**
 * Dotted keys such as "web.enabled" override a field inside a top-level
 * settings object. `thinkingLevel` is always listed: every run sets it from
 * the plan, so it is restored like any case override.
 */
function topLevelSettingKeys(cases: readonly ToolUseCase[]): string[] {
  return [
    ...new Set([
      "thinkingLevel",
      ...cases.flatMap((entry) => Object.keys(entry.settings ?? {}).map((key) => key.split(".")[0])),
    ]),
  ];
}

/**
 * Configure the plugin for a fixed, comparable eval and return the configured
 * value of every top-level settings key that a case overrides. Each run
 * restores those values first, so one case's override never reaches the next.
 */
async function configurePlugin(): Promise<Record<string, unknown>> {
  const apiKey = process.env.AGENTIC_CHAT_API_KEY?.trim();
  if (!apiKey) throw new Error("AGENTIC_CHAT_API_KEY is missing for the tool-use eval spec");
  const base = await browser.executeObsidian(async ({ app }, config) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }>;
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
      mcp: { enabled: boolean; proxyUrl: string; noProxy: string; servers: McpServerSettings[] };
      toolBudget: { enabled: boolean };
      maxTokens: number;
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = config.apiKey;
    settings.openrouterModel = config.model;
    // Hold the sampling fixed. The reasoning level comes from the plan, per
    // run (see applyCaseSettings), so a comparison names the level it used.
    settings.temperature = 0;
    settings.mode = "safe";
    settings.approval.mutating = "allow";
    // The eval vault is synthetic. Recursive deletes still ask even under a
    // blanket allow, and the approval modal would block the stop button and
    // hang the turn. A per-tool allow lets the run finish; the checks, not a
    // modal, decide whether the delete was right.
    settings.approval.perTool = { delete: "allow" };
    // The eval vault holds no private data, so provider privacy filters add
    // routing noise without protecting anything. Pin one provider path so a
    // fallback or a ZDR filter does not move the score.
    settings.privacy.allowFallbacks = false;
    settings.privacy.denyDataCollection = false;
    settings.privacy.requireZDR = false;
    settings.web.enabled = false;
    settings.mcp.enabled = false;
    if (config.mcpServers.length > 0) {
      // The plan named this run's fake MCP server, so the plugin gets exactly
      // one MCP server. The base leaves mcp.enabled false; a case that sets
      // "mcp.enabled": true turns MCP on for its own runs only.
      settings.mcp.proxyUrl = "";
      settings.mcp.noProxy = "localhost,127.0.0.1,::1";
      settings.mcp.servers = config.mcpServers;
    }
    settings.toolBudget.enabled = false;
    // A provider reserves the request's max output tokens against the key's
    // credit. A run never needs more than a few thousand output tokens, so
    // cap it and leave the key budget for the whole suite.
    settings.maxTokens = 8192;
    settings.maxTurnsPerPrompt = config.maxTurnsPerPrompt;
    settings.ignoredGlobs = "";
    await plugin.saveSettings?.();
    // WebDriver serializes the return value, so this is a copy: a later case
    // override cannot write through to it.
    const configured = plugin.settings;
    return Object.fromEntries(config.overridableKeys.map((key) => [key, configured[key]]));
  }, {
    pluginId: PLUGIN_ID,
    apiKey,
    model: plan.model,
    maxTurnsPerPrompt: plan.turn.maxTurnsPerPrompt,
    mcpServers: plan.mcpFixtureUrl ? [fixtureMcpServer(plan.mcpFixtureUrl)] : [],
    overridableKeys: topLevelSettingKeys(plan.cases),
  });
  if (!base) throw new Error("agentic-chat plugin not found in the tool-use vault");
  return base;
}

async function applyCaseSettings(
  caseSettings: NonNullable<ToolUseCase["settings"]>,
  thinkingLevel: string,
): Promise<void> {
  await browser.executeObsidian(async ({ app }, payload) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }>;
      };
    }).plugins?.plugins?.[payload.pluginId];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings;
    for (const [key, value] of Object.entries(payload.base)) settings[key] = value;
    for (const [dottedKey, value] of Object.entries(payload.caseSettings)) {
      const parts = dottedKey.split(".");
      let cursor = settings;
      for (const part of parts.slice(0, -1)) {
        const next = cursor[part];
        if (next === null || typeof next !== "object" || Array.isArray(next)) cursor[part] = {};
        cursor = cursor[part] as Record<string, unknown>;
      }
      cursor[parts[parts.length - 1]] = value;
    }
    settings.thinkingLevel = payload.thinkingLevel;
    await plugin.saveSettings?.();
  }, { pluginId: PLUGIN_ID, base: baseSettings, caseSettings, thinkingLevel });
}

/** Replace the whole vault content (not `.obsidian`) with the case seed. */
async function seedVault(files: Record<string, string>, binaryFiles: Record<string, string>): Promise<void> {
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
  }, { files, binaryFiles });
}

/**
 * Read what the run left in the vault: every file path, the Markdown text, and
 * the frontmatter and links as Obsidian's own metadata cache resolved them.
 */
async function observeVault(): Promise<VaultObservation> {
  return await browser.executeObsidian(async ({ app }, settleTimeoutMs) => {
    const markdown = app.vault.getMarkdownFiles();
    const files: Record<string, string> = {};
    for (const file of markdown) files[file.path] = await app.vault.read(file);

    const readCache = () => {
      const resolved = app.metadataCache.resolvedLinks as Record<string, Record<string, number>>;
      const unresolved = app.metadataCache.unresolvedLinks as Record<string, Record<string, number>>;
      const frontmatter: Record<string, Record<string, unknown>> = {};
      const links: Record<string, string[]> = {};
      const unresolvedLinks: Record<string, string[]> = {};
      let ready = true;
      for (const file of markdown) {
        const cache = app.metadataCache.getFileCache(file);
        if (!cache) ready = false;
        if (cache?.frontmatter) {
          // `position` is the parser's own bookkeeping, not a property.
          const { position: _position, ...properties } = cache.frontmatter as Record<string, unknown>;
          frontmatter[file.path] = properties;
        }
        links[file.path] = Object.keys(resolved[file.path] ?? {});
        const targets = Object.keys(unresolved[file.path] ?? {});
        if (targets.length > 0) unresolvedLinks[file.path] = targets;
      }
      const state = { frontmatter, links, unresolvedLinks };
      return { ready, state, key: JSON.stringify(state) };
    };

    // Obsidian indexes after the turn, so one read can catch a partial cache.
    // Accept a snapshot only when every note is indexed and two reads in a
    // row agree; after the settle timeout, take the last read.
    const deadline = Date.now() + settleTimeoutMs;
    let previousKey: string | undefined;
    let snapshot = readCache();
    while (!(snapshot.ready && snapshot.key === previousKey) && Date.now() < deadline) {
      previousKey = snapshot.ready ? snapshot.key : undefined;
      await new Promise((resolve) => setTimeout(resolve, 250));
      snapshot = readCache();
    }
    return { files, paths: app.vault.getFiles().map((file) => file.path), ...snapshot.state };
  }, SETTLE_TIMEOUT_MS);
}

function emptyVaultObservation(): VaultObservation {
  const { toolCalls: _toolCalls, answer: _answer, ...vault } = emptyObservation();
  return vault;
}

function emptySessionObservation(): SessionObservation {
  return { toolCalls: [], answer: "", usage: {}, modelCalls: 0 };
}

function observeSession(raw: string): SessionObservation {
  const analysis = analyzer.analyzeSessionText(raw);
  const file = analysis.files[0];
  const observedLevel = observedThinkingLevel(raw);
  const billedUsd = billedCostUsd(raw);
  return {
    toolCalls: file?.toolCalls ?? [],
    answer: file?.finalAssistantText ?? "",
    usage: { ...(analysis.aggregate.usage ?? {}), ...(billedUsd > 0 ? { billedUsd } : {}) },
    modelCalls: analysis.aggregate.messages?.assistant ?? 0,
    ...(observedLevel ? { observedThinkingLevel: observedLevel } : {}),
  };
}

/**
 * Sum the cost OpenRouter billed. pi-ai stores it as `usage.cost.total` with
 * `totalFromProvider: true`; the other cost fields are catalog estimates, so
 * only `total` is read. All or nothing: if one assistant message that used
 * tokens has no billed cost, a partial sum would be too low, so this returns 0
 * and the runner prices the whole run from the price table instead. A message
 * with no tokens (an aborted turn) cost nothing and is skipped.
 */
function billedCostUsd(raw: string): number {
  let total = 0;
  for (const entry of sessionEntries(raw)) {
    if (entry?.message?.role !== "assistant") continue;
    const usage = entry.message.usage;
    const cost = usage?.cost;
    if (cost?.totalFromProvider === true && typeof cost.total === "number" && Number.isFinite(cost.total)) {
      total += cost.total;
    } else if (typeof usage?.totalTokens === "number" && usage.totalTokens > 0) {
      return 0;
    }
  }
  return total;
}

/**
 * The last `thinking_level_change` entry is the level the last request used.
 * Report it, never fail on it: the provider may clamp, and a mismatch is data.
 */
function observedThinkingLevel(raw: string): string | undefined {
  let level: string | undefined;
  for (const entry of sessionEntries(raw)) {
    if (entry?.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") level = entry.thinkingLevel;
  }
  return level;
}

/** Session JSONL entries; a line that is not JSON reads as `undefined`. */
function sessionEntries(raw: string): Array<SessionEntry | undefined> {
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as SessionEntry;
      } catch {
        return undefined;
      }
    });
}

/** A provider 402/429 is a run error, not an empty answer. The trace keeps it on the assistant message. */
function sessionApiError(raw: string): string | undefined {
  for (const entry of sessionEntries(raw)) {
    if (!entry) return "the session trace is not valid JSON";
    if (entry.message?.stopReason === "error") return entry.message.errorMessage ?? "unknown provider error";
  }
  return undefined;
}

function hasAssistantMessage(raw: string): boolean {
  return sessionEntries(raw).some((entry) => entry?.type === "message" && entry.message?.role === "assistant");
}

/** Read the one session file that this run's new-conversation created. */
async function readNewSession(sessionBaseline: string[]): Promise<string> {
  const known = new Set(sessionBaseline);
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let added: string[] = [];
  while (Date.now() < deadline) {
    added = (await listSessionPaths()).filter((sessionPath) => !known.has(sessionPath));
    if (added.length > 1) break;
    if (added.length === 1) {
      const raw = await browser.executeObsidian(({ app }, target) => app.vault.adapter.read(target), added[0]);
      if (hasAssistantMessage(raw)) return raw;
    }
    await browser.pause(100);
  }
  if (added.length !== 1) {
    throw new Error(
      `Expected exactly one new session file for this run, found ${added.length}` +
        (added.length > 0 ? `: ${added.join(", ")}` : ""),
    );
  }
  throw new Error(`The new session ${added[0]} did not get an assistant message within ${SETTLE_TIMEOUT_MS / 1000} s`);
}

async function listSessionPaths(): Promise<string[]> {
  return await browser.executeObsidian(async ({ app }, pluginId) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { manifest?: { dir?: string } }> };
    }).plugins?.plugins?.[pluginId];
    const pluginDir = plugin?.manifest?.dir ?? `${app.vault.configDir}/plugins/${pluginId}`;
    const sessionsDir = `${pluginDir}/sessions`;
    const adapter = app.vault.adapter;
    if (!(await adapter.exists(sessionsDir))) return [];
    const listing = await adapter.list(sessionsDir);
    return listing.files.filter((file) => file.endsWith(".jsonl"));
  }, PLUGIN_ID);
}

/**
 * The shared turn-end wait also waits for an open ask-user card to close, but
 * an eval run cannot answer it. Stop at the card and let the checks grade the
 * tool call; `endTurn` then stops the waiting turn.
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

/** Leave no turn and no modal behind: close open modals, then stop a live turn. Throws if the turn will not stop. */
async function endTurn(): Promise<void> {
  // A modal left open by a run (for example a confirm dialog) covers the stop button.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await browser.execute(() => document.querySelectorAll(".modal-container").length);
    if (open === 0) break;
    await browser.keys("Escape");
    await browser.pause(200);
  }
  const stop = await $(".agentic-chat-stop");
  if (!(await stop.isDisplayed().catch(() => false))) return;
  try {
    await stop.click();
    await browser.waitUntil(async () => !(await stop.isDisplayed().catch(() => false)), { timeout: 10_000 });
  } catch (error) {
    throw new Error(`tool-use turn did not stop within 10 s (${errorMessage(error)})`, { cause: error });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
