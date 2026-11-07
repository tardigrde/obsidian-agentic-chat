import { existsSync, readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import {
  decideStop,
  estimateTokens,
  redactSecrets,
  type ChaosCaps,
  type ChaosPlan,
  type ChaosStopState,
  type ChaosTarget,
} from "../../../scripts/chaos/monkey-core";
import {
  clickMcpAddButton,
  closeAgenticChatSettings,
  openAgenticChatSettings,
  readSettingsTabLabels,
  selectSettingsTab,
  setSettingTextByPlaceholder,
  setSettingToggle,
  waitForAgenticChatSetting,
  waitForMcpAddRow,
} from "../support/settings-ui";
import { mark, writeMetrics } from "../support/record";
import {
  configurePlugin,
  installScriptedTurns,
  noteExists,
  openChat,
  readNote,
  renderedAssistantText,
  sendPrompt,
  type ScriptedTurn,
} from "../probe/support/probe-helpers";

/**
 * Committed live driver for `@chaos-monkey`.
 *
 * The runner writes a plan and starts this spec through the normal e2e
 * transport. This file is stable driver code, not a generated one-off spec:
 * every run uses the same actions, and the plan only chooses mode, target, and
 * caps. The driver refuses to run without a plan.
 */

type Surface = ChaosTarget | "slash-commands";

type Action = {
  id: string;
  surface: Surface;
  description: string;
  prompt?: string;
  notePath?: string;
};

type Finding = {
  severity: "S1" | "S2" | "S3" | "S4";
  step: string;
  message: string;
};

type DriverResult = {
  verdict: "PASS" | "FINDINGS" | "INCONCLUSIVE";
  stopReason: string;
  mode: string;
  target?: string;
  live: boolean;
  steps: Array<{ id: string; surface: string; status: "passed" | "failed"; detail?: string }>;
  findings: Finding[];
  calls: number;
  tokens: number;
  assistantChars: number;
  settingsToggled: boolean;
  notes: Array<{ path: string; exists: boolean; content?: string }>;
  runnerNotes: string[];
  mcp: { rendered: boolean; added: boolean };
  clock: { startedAt: number; finishedAt: number };
  caps: ChaosCaps;
};

const planPath = process.env.AGENTIC_CHAT_CHAOS_PLAN?.trim();
const outDir = process.env.AGENTIC_CHAT_CHAOS_OUT?.trim();
const apiKey = readApiKey();
let plan: ChaosPlan;
const scratchDir = "Chaos";
const sessionNote = (index: number): string => `${scratchDir}/Chaos ${index}.md`;

function readApiKey(): string | undefined {
  const inline = process.env.AGENTIC_CHAT_API_KEY?.trim();
  if (inline) return inline;
  const file = process.env.AGENTIC_CHAT_API_KEY_FILE?.trim();
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

async function loadPlan(): Promise<ChaosPlan> {
  if (!planPath) throw new Error("AGENTIC_CHAT_CHAOS_PLAN is required; start the run through npm run chaos");
  const raw = JSON.parse(await readFile(planPath, "utf8")) as ChaosPlan;
  if (raw.version !== 1) throw new Error(`unsupported chaos plan version: ${String(raw.version)}`);
  return raw;
}

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function actionCatalog(): Action[] {
  return [
    {
      id: "composer-prompt",
      surface: "composer",
      description: "send one free-form prompt and read the answer",
      prompt: "In one short sentence, say what you can do in this Obsidian vault.",
    },
    {
      id: "slash-help",
      surface: "slash-commands",
      description: "run /help in the composer",
      prompt: "/help",
    },
    {
      id: "slash-dirs",
      surface: "slash-commands",
      description: "run /dirs in the composer",
      prompt: "/dirs",
    },
    {
      id: "settings-tabs",
      surface: "settings",
      description: "open Agentic Chat settings, switch every tab, and toggle MCP",
    },
    {
      id: "mcp-surface",
      surface: "mcp",
      description: "open Advanced, enable MCP, add a server, and read the row",
    },
  ];
}

function noteAction(index: number): Action {
  return {
    id: `notes-write-${index}`,
    surface: "notes",
    description: "ask the model to create a note, approve the write, and read it back",
    prompt: `Create the note ${sessionNote(index)} with exactly this content: chaos monkey step ${index}`,
    notePath: sessionNote(index),
  };
}

function focusedSequence(target: ChaosTarget): Action[] {
  switch (target) {
    case "composer":
      return [actionCatalog()[0], actionCatalog()[1], actionCatalog()[2]];
    case "settings":
      return [actionCatalog()[3]];
    case "mcp":
      return [actionCatalog()[4], actionCatalog()[3]];
    case "notes":
      return [noteAction(1), noteAction(2)];
  }
}

function genericSequence(caps: ChaosCaps, seed: number): Action[] {
  const pool = actionCatalog();
  const random = rng(seed);
  const sequence: Action[] = [];
  let notes = 0;
  for (let index = 0; index < caps.maxSteps; index += 1) {
    const roll = random();
    if (roll < 0.4) {
      notes += 1;
      sequence.push(noteAction(notes));
    } else {
      sequence.push(pool[Math.floor(random() * pool.length)]);
    }
  }
  return sequence;
}

function scriptedTurnsFor(sequence: Action[]): ScriptedTurn[] {
  const turns: ScriptedTurn[] = [];
  for (const action of sequence) {
    if (!action.prompt || action.prompt.startsWith("/")) continue;
    if (action.notePath) {
      const notePath = action.notePath;
      turns.push({
        label: `${action.id} write`,
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: `${action.id}-write`,
            name: "write",
            arguments: { path: notePath, content: "chaos monkey was here" },
          },
        ],
      });
      turns.push({
        label: `${action.id} final`,
        stopReason: "stop",
        content: [{ type: "text", text: `Created ${notePath}.` }],
      });
    } else {
      turns.push({
        label: `${action.id} reply`,
        stopReason: "stop",
        content: [{ type: "text", text: `Chaos reply for ${action.id}.` }],
      });
    }
  }
  return turns;
}

let result: DriverResult;

function state(): ChaosStopState {
  return {
    startedAt: startedAt,
    steps: result.steps.length,
    calls: result.calls,
    tokens: result.tokens,
    canceled: plan.cancelFile !== "" && existsSync(plan.cancelFile),
    now: Date.now(),
  };
}

function checkBudget(): string | undefined {
  const decision = decideStop(plan.caps, state());
  if (!decision.stop) return undefined;
  return decision.reason;
}

async function logAction(action: Action, status: "started" | "passed" | "failed", detail?: string): Promise<void> {
  if (!outDir) return;
  const entry = {
    t: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
    step: action.id,
    surface: action.surface,
    description: action.description,
    status,
    detail: detail ? redactSecrets(detail, [apiKey]) : undefined,
  };
  await mkdir(outDir, { recursive: true });
  await appendFile(path.join(outDir, "action-log.jsonl"), `${JSON.stringify(entry)}\n`);
}

async function screenshot(label: string): Promise<void> {
  if (!outDir) return;
  try {
    await mkdir(path.join(outDir, "shots"), { recursive: true });
    await browser.saveScreenshot(path.join(outDir, "shots", `${label}.png`));
  } catch {
    // A screenshot is extra evidence; the run does not depend on it.
  }
}

async function approveIfPresent(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const modal = await $(".agentic-chat-approval");
    if (await modal.isExisting()) {
      await modal.waitForDisplayed({ timeout: 5_000 }).catch(() => undefined);
      const allow = await modal.$("button=Allow");
      if (await allow.isExisting()) {
        await allow.click();
        return true;
      }
    }
    await browser.pause(500);
  }
  return false;
}

/**
 * Wait for new, stable assistant text without depending on the one-bubble
 * streaming marker. Tool-call turns can leave an earlier empty bubble with
 * `is-streaming`, which makes the shared probe helper wait forever.
 */
async function waitForStableAnswer(previous: string, timeoutMs: number): Promise<string> {
  let latest = previous;
  let repeats = 0;
  await browser.waitUntil(
    async () => {
      const next = await renderedAssistantText();
      if (next.trim().length <= previous.trim().length) {
        repeats = 0;
        return false;
      }
      repeats = next === latest ? repeats + 1 : 0;
      latest = next;
      return repeats >= 1;
    },
    { timeout: timeoutMs, interval: 500, timeoutMsg: "assistant produced no new stable text" },
  );
  return latest;
}

async function runPrompt(action: Action): Promise<void> {
  if (action.prompt?.startsWith("/")) {
    await sendPrompt(action.prompt);
    const expected = action.prompt === "/help" ? ".agentic-chat-info" : ".agentic-chat-action-list";
    await $(expected).waitForExist({ timeout: 15_000 });
    await browser.pause(300);
    return;
  }

  const beforeAnswer = await renderedAssistantText();
  result.calls += 1;
  result.tokens += estimateTokens(action.prompt ?? "");

  await sendPrompt(action.prompt ?? "");
  if (action.notePath) await approveIfPresent(30_000);
  const remainingMs = plan.caps.maxSeconds * 1000 - (Date.now() - startedAt);
  const timeout = Math.max(15_000, Math.min(120_000, remainingMs));
  const answer = await waitForStableAnswer(beforeAnswer, timeout);
  result.assistantChars += answer.length;
  result.tokens += estimateTokens(answer);

  if (action.notePath) {
    const exists = await noteExists(action.notePath);
    let content = "";
    if (exists) content = await readNote(action.notePath);
    result.notes.push({ path: action.notePath, exists, content });
    if (!exists || !content.includes("chaos monkey")) {
      throw new Error(`note ${action.notePath} was not written as requested`);
    }
  }
}

async function runSettings(): Promise<void> {
  await openAgenticChatSettings();
  const tabs = await readSettingsTabLabels();
  expect(tabs.length).toBeGreaterThan(0);
  for (const tab of tabs) {
    await selectSettingsTab(tab);
    await browser.pause(150);
  }
  await selectSettingsTab("Advanced");
  await setSettingToggle("Enable MCP", true);
  await waitForMcpAddRow();
  await waitForAgenticChatSetting(
    (settings) => (settings.mcp as { enabled?: boolean } | undefined)?.enabled === true,
    "MCP did not enable",
  );
  await setSettingToggle("Enable MCP", false);
  await waitForAgenticChatSetting(
    (settings) => (settings.mcp as { enabled?: boolean } | undefined)?.enabled !== true,
    "MCP did not disable",
  );
  result.settingsToggled = true;
  await browser.pause(300);
  await closeAgenticChatSettings();
}

async function runMcp(): Promise<void> {
  const endpoint = plan.live && plan.mcpUrl ? plan.mcpUrl : "https://example.invalid/mcp";
  await openAgenticChatSettings();
  await selectSettingsTab("Advanced");
  await setSettingToggle("Enable MCP", true);
  await waitForMcpAddRow();
  result.mcp.rendered = true;
  await setSettingTextByPlaceholder("Server name", "chaos");
  await setSettingTextByPlaceholder("https://mcp.example.com/mcp", endpoint);
  await clickMcpAddButton("Add MCP server");
  const rows = await browser.execute(
    () => document.querySelectorAll(".agentic-chat-mcp-server-header").length,
  );
  result.mcp.added = rows > 0;
  if (plan.live && plan.mcpUrl) {
    // The live MCP call itself is owned by `mcp-live.e2e.ts`; this driver only
    // proves the add-server surface. Record that limitation in the report.
    result.runnerNotes.push(
      "live MCP tool call is not driven here; run test/e2e/specs/mcp-live.e2e.ts for the call",
    );
  }
  await browser.pause(400);
  await closeAgenticChatSettings();
}

async function runAction(action: Action): Promise<void> {
  await mark(`step ${action.id}`);
  await logAction(action, "started");
  try {
    if (action.surface === "settings") await runSettings();
    else if (action.surface === "mcp") await runMcp();
    else await runPrompt(action);
    result.steps.push({ id: action.id, surface: action.surface, status: "passed" });
    await logAction(action, "passed");
    await screenshot(action.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.steps.push({ id: action.id, surface: action.surface, status: "failed", detail: message });
    result.findings.push({ severity: "S2", step: action.id, message });
    await logAction(action, "failed", message);
    await screenshot(`${action.id}-failed`);
    // Repeated identical failures mean the harness is broken, not the product.
    const sameCause = result.findings.filter((finding) => finding.message === message).length;
    if (sameCause >= 2) stopReason = "repeated-failure";
  }
  await browser.pause(250);
}

let startedAt = Date.now();
let stopReason = "completed";
let sequence: Action[] = [];

describe("chaos monkey live driver", function () {
  this.timeout(600_000);

  before(async function () {
    plan = await loadPlan();
    if (plan.live && !apiKey) throw new Error("live plan needs AGENTIC_CHAT_API_KEY");
    this.timeout(Math.max(60_000, plan.caps.maxSeconds * 1000 + 60_000));
    startedAt = Date.now();
    result = {
      verdict: "INCONCLUSIVE",
      stopReason: "completed",
      mode: plan.mode,
      target: plan.target,
      live: plan.live,
      steps: [],
      findings: [],
      calls: 0,
      tokens: 0,
      assistantChars: 0,
      settingsToggled: false,
      notes: [],
      runnerNotes: [],
      mcp: { rendered: false, added: false },
      clock: { startedAt, finishedAt: startedAt },
      caps: plan.caps,
    };

    sequence = plan.mode === "focused" ? focusedSequence(plan.target ?? "composer") : genericSequence(plan.caps, plan.seed);
    if (sequence.length > plan.caps.maxSteps) sequence = sequence.slice(0, plan.caps.maxSteps);

    if (!plan.live) await installScriptedTurns(scriptedTurnsFor(sequence));

    await configurePlugin({
      provider: plan.live ? "openai-compatible" : "openrouter",
      openrouterApiKey: plan.live ? undefined : "e2e-scripted-key",
      openaiCompatibleApiKey: plan.live ? apiKey : undefined,
      openaiCompatibleBaseUrl: plan.live ? plan.baseUrl : undefined,
      openaiCompatibleModel: plan.live ? plan.model : undefined,
      requestTimeoutMs: 120_000,
      maxNetworkRetries: 0,
      mode: "safe",
      approval: { mutating: "ask", perTool: {}, workingDirs: [] },
      web: { enabled: false },
    });
    await openChat();
    await mark("chat open");
  });

  after(async function () {
    if (!result) return;
    result.clock.finishedAt = Date.now();
    result.stopReason = stopReason;
    result.verdict =
      result.steps.length === 0
        ? "INCONCLUSIVE"
        : result.findings.length > 0
          ? "FINDINGS"
          : "PASS";

    if (outDir) {
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, "driver-result.json"), `${JSON.stringify(redactedResult(result), null, 2)}\n`);
      await writeMetrics({
        mode: plan.mode,
        target: plan.target,
        live: plan.live,
        steps: result.steps.length,
        findings: result.findings.length,
        calls: result.calls,
        estimatedTokens: result.tokens,
        stopReason: result.stopReason,
        verdict: result.verdict,
      });
      await copySessions(outDir).catch(() => undefined);
    }

    try {
      await closeAgenticChatSettings();
    } catch {
      // Settings may already be closed.
    }
  });

  it("drives the planned surfaces under the hard caps", async function () {
    for (const action of sequence) {
      const stop = checkBudget();
      if (stop) {
        stopReason = stop;
        break;
      }
      await runAction(action);
      if (stopReason.startsWith("repeated")) break;
    }

    const finalStop = checkBudget();
    if (finalStop && stopReason === "completed") stopReason = finalStop;
    if (stopReason === "completed") stopReason = "sequence-complete";

    expect(result.steps.length).toBeGreaterThan(0);
  });
});

/** Keep the machine-readable result free of key material, like the report. */
function redactedResult(value: DriverResult): DriverResult {
  return {
    ...value,
    steps: value.steps.map((step) => ({
      ...step,
      detail: step.detail ? redactSecrets(step.detail, [apiKey]) : undefined,
    })),
    findings: value.findings.map((finding) => ({
      ...finding,
      message: redactSecrets(finding.message, [apiKey]),
    })),
    notes: value.notes.map((note) => ({
      ...note,
      content: note.content ? redactSecrets(note.content, [apiKey]) : undefined,
    })),
  };
}

async function copySessions(target: string): Promise<void> {
  const sessionDir = await browser.executeObsidian(async ({ app }, pluginId) => {
    const basePath = (app.vault.adapter as unknown as { basePath?: string }).basePath;
    if (!basePath) return "";
    return `${basePath}/${app.vault.configDir}/plugins/${pluginId}/sessions`;
  }, "agentic-chat");

  if (!sessionDir || !existsSync(sessionDir)) return;
  const files = await readdir(sessionDir);
  const destination = path.join(target, "sessions");
  await mkdir(destination, { recursive: true });
  for (const file of files.filter((entry) => entry.endsWith(".jsonl"))) {
    await copyFile(path.join(sessionDir, file), path.join(destination, file));
  }
}
