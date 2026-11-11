import { existsSync, readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import {
  CHAOS_TARGETS,
  decideStop,
  estimateTokens,
  redactSecrets,
  type ChaosCaps,
  type ChaosPlan,
  type ChaosStopState,
  type ChaosTarget,
} from "../../../scripts/chaos/monkey-core";
import {
  ALLOWED_NOTE,
  DENIED_NOTE,
  MODEL_RETIRED_COMMANDS,
  RETIRED_COMMANDS,
  focusedSequence,
  genericSequence,
  modelCallsFor,
  planChaosBudget,
  scriptedTurnsFor,
  type ChaosAction,
  type ChaosBudgetStep,
} from "../../../scripts/chaos/monkey-actions";
import {
  clickMcpAddButton,
  closeAgenticChatSettings,
  openAgenticChatSettings,
  readAgenticChatSettings,
  readSettingsTabLabels,
  selectSettingsTab,
  setSettingText,
  setSettingTextByPlaceholder,
  setSettingToggle,
  waitForAgenticChatSetting,
  waitForMcpAddRow,
} from "../support/settings-ui";
import { mark, writeMetrics } from "../support/record";
import { runExplorer, type ExplorerOutcome } from "./explorer-driver";
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
import { withHangTimeout } from "../../../scripts/chaos/hang-timeout";

/**
 * Committed live driver for `@chaos-monkey`.
 *
 * The runner writes a plan and starts this spec through the normal e2e
 * transport. This file is stable driver code, not a generated one-off spec:
 * every run uses the same actions, and the plan only chooses mode, target, and
 * caps. The driver refuses to run without a plan.
 */

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
  steps: Array<{ id: string; surface: string; status: "passed" | "failed" | "skipped"; detail?: string }>;
  findings: Finding[];
  calls: number;
  tokens: number;
  skippedSteps: number;
  assistantChars: number;
  settingsToggled: boolean;
  notes: Array<{ path: string; exists: boolean; content?: string }>;
  runnerNotes: string[];
  mcp: { rendered: boolean; added: boolean };
  clock: { startedAt: number; finishedAt: number };
  caps: ChaosCaps;
  explorer?: ExplorerOutcome["explorer"];
  plugin?: ExplorerOutcome["plugin"];
};

/** Scenarios the explorer may call as macros. max-turns spends 25 calls, so it stays out. */
const EXPLORER_SCENARIOS = CHAOS_TARGETS.filter((target) => target !== "max-turns");

/** Generic answers for a dry replay: the plugin side stays scripted and free. */
function dryReplayTurns(count: number): ScriptedTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    label: `dry-replay-${index + 1}`,
    stopReason: "stop" as const,
    content: [{ type: "text", text: `Dry replay answer ${index + 1}.` }],
  }));
}

/** Run one focused scenario for the explorer; keep its steps out of the explorer step list. */
async function runScenarioForExplorer(name: string): Promise<string | undefined> {
  const stepsBefore = result.steps.length;
  const findingsBefore = result.findings.length;
  for (const action of focusedSequence(name as ChaosTarget)) await runAction(action);
  const scenarioSteps = result.steps.splice(stepsBefore);
  const failures = scenarioSteps.filter((step) => step.status === "failed").map((step) => `${step.id}: ${step.detail ?? ""}`);
  for (const finding of result.findings.slice(findingsBefore)) finding.step = `scenario:${name}/${finding.step}`;
  return failures.length > 0 ? failures.join("; ") : undefined;
}

const planPath = process.env.AGENTIC_CHAT_CHAOS_PLAN?.trim();
const outDir = process.env.AGENTIC_CHAT_CHAOS_OUT?.trim();
const apiKey = readApiKey();
let plan: ChaosPlan;

const LARGE_INPUT_CHARS = 20_000;
const STEER_TEXT = "keep the answer concise and end with the word steered";
const QUEUE_DRAFT = "queued draft before edit";
const QUEUE_EDITED = "queued draft after edit";
const STOP_REPLACEMENT = "replacement after stop";

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

let result: DriverResult;

function state(): ChaosStopState {
  return {
    startedAt: startedAt,
    // A skipped action is not a user-visible step, so it does not spend the
    // --max-steps budget. The sampled sequence is already capped by maxSteps.
    steps: result.steps.filter((step) => step.status !== "skipped").length,
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

async function logAction(
  action: ChaosAction,
  status: "started" | "passed" | "failed" | "skipped",
  detail?: string,
): Promise<void> {
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

async function transcriptText(): Promise<string> {
  return await $(".agentic-chat-messages").getText();
}

async function sendWithButton(text: string): Promise<void> {
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(text);
  await $(".agentic-chat-send").click();
}

async function pressEnter(): Promise<void> {
  await browser.keys("Enter");
}

async function setE2ERelease(release: boolean): Promise<void> {
  await browser.execute((value) => {
    const target = window as typeof window & { __AGENTIC_CHAT_E2E_RELEASE__?: boolean };
    target.__AGENTIC_CHAT_E2E_RELEASE__ = value;
  }, release);
}

async function scriptedCallLabels(): Promise<string[]> {
  return await browser.execute(() => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_CALL_LOG__?: Array<{ label?: string }>;
    };
    return target.__AGENTIC_CHAT_E2E_CALL_LOG__?.map((call) => call.label ?? "") ?? [];
  });
}

async function waitForCall(label: string): Promise<void> {
  await browser.waitUntil(async () => (await scriptedCallLabels()).includes(label), {
    timeout: 15_000,
    timeoutMsg: `scripted call ${label} never started`,
  });
}

async function isRunning(): Promise<boolean> {
  return await browser.execute(() => {
    const stop = document.querySelector<HTMLElement>(".agentic-chat-stop");
    return Boolean(stop && stop.offsetParent !== null);
  });
}

async function waitForRunning(timeout = 30_000): Promise<void> {
  await browser.waitUntil(isRunning, { timeout, timeoutMsg: "the turn never started running" });
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

async function approveIfPresent(timeoutMs: number, allowed: boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const modal = await $(".agentic-chat-approval");
    if (await modal.isExisting()) {
      await modal.waitForDisplayed({ timeout: 5_000 }).catch(() => undefined);
      if (allowed) {
        const allow = await modal.$("button=Allow");
        if (await allow.isExisting()) {
          await allow.click();
          return true;
        }
      } else {
        const clicked = await browser.execute(() => {
          const modalEl = document.querySelector<HTMLElement>(".agentic-chat-approval");
          if (!modalEl) return false;
          const buttons = Array.from(modalEl.querySelectorAll<HTMLButtonElement>("button"));
          const deny = buttons.find((button) => button.innerText.trim() === "Deny");
          if (deny) {
            deny.click();
            return true;
          }
          return false;
        });
        if (!clicked) continue;
        await browser.pause(200);
        const confirmed = await browser.execute(() => {
          const modalEl = document.querySelector<HTMLElement>(".agentic-chat-approval");
          if (!modalEl) return false;
          const buttons = Array.from(modalEl.querySelectorAll<HTMLButtonElement>("button"));
          const confirm = buttons.find((button) => button.innerText.trim() === "Confirm Deny");
          if (confirm) {
            confirm.click();
            return true;
          }
          return false;
        });
        if (!confirmed) {
          // Some builds deny in one click; treat the disappearing modal as success.
          await browser.pause(200);
          const stillOpen = await $(".agentic-chat-approval").isExisting();
          if (!stillOpen) return true;
          continue;
        }
        return true;
      }
    }
    await browser.pause(500);
  }
  return false;
}

async function configureApproval(mutating: string, perTool: Record<string, string> = {}): Promise<void> {
  await configurePlugin({ mode: "safe", approval: { mutating, perTool } });
}

// Read once while Obsidian answers; later calls (end-of-run checks, the
// after hook) read only the disk, so a frozen Obsidian cannot block them.
let cachedSessionDir = "";

async function sessionDirPath(): Promise<string> {
  if (cachedSessionDir) return cachedSessionDir;
  cachedSessionDir = await browser.executeObsidian(async ({ app }, pluginId) => {
    const basePath = (app.vault.adapter as unknown as { basePath?: string }).basePath;
    if (!basePath) return "";
    return `${basePath}/${app.vault.configDir}/plugins/${pluginId}/sessions`;
  }, "agentic-chat");
  return cachedSessionDir;
}

/** Parse every session JSONL; throw with the file and line on corruption. */
async function assertSessionsValid(): Promise<{ files: number; lines: number }> {
  const dir = await sessionDirPath();
  if (!dir || !existsSync(dir)) return { files: 0, lines: 0 };
  const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  let lines = 0;
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8");
    const rows = text.split(/\r?\n/).filter(Boolean);
    rows.forEach((row, index) => {
      try {
        const entry = JSON.parse(row) as { type?: unknown };
        if (typeof entry.type !== "string") throw new Error("missing type");
      } catch (error) {
        throw new Error(
          `session ${file} line ${index + 1} is not valid JSONL: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      lines += 1;
    });
  }
  return { files: files.length, lines };
}

async function countErrorPanels(): Promise<number> {
  return await browser.execute(() => document.querySelectorAll(".agentic-chat-info-error").length);
}

async function waitForNewAnswer(previous: string, timeoutMs: number): Promise<string> {
  const remainingMs = plan.caps.maxSeconds * 1000 - (Date.now() - startedAt);
  const timeout = Math.max(15_000, Math.min(timeoutMs, remainingMs));
  const answer = await waitForStableAnswer(previous, timeout);
  result.assistantChars += answer.length;
  result.tokens += estimateTokens(answer);
  return answer;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runPrompt(action: ChaosAction): Promise<void> {
  const beforeAnswer = await renderedAssistantText();
  result.calls += modelCallsFor(action);
  result.tokens += estimateTokens(action.prompt ?? "");

  await sendPrompt(action.prompt ?? "");
  if (action.notePath) await approveIfPresent(30_000, true);
  await waitForNewAnswer(beforeAnswer, 120_000);

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

async function runSlash(action: ChaosAction): Promise<void> {
  const panelsBefore = await browser.execute(() => document.querySelectorAll(".agentic-chat-info").length);
  await sendPrompt(action.prompt ?? "");
  // `/help` and `/status` both answer locally with a new info panel. `/status`
  // lists the provider; an action list belongs to `/memory manage`, not here.
  const expected = action.prompt === "/status" ? "Provider" : "";
  await browser.waitUntil(
    async () =>
      await browser.execute(
        (before, text) => {
          const panels = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-info"));
          const latest = panels.at(-1);
          return panels.length > before && Boolean(latest) && (latest as HTMLElement).innerText.includes(text);
        },
        panelsBefore,
        expected,
      ),
    { timeout: 15_000, timeoutMsg: `${action.prompt ?? "slash command"} did not render a new info panel` },
  );
  await browser.pause(300);
}

async function runRetiredCommands(action: ChaosAction): Promise<void> {
  void action;
  const errorsBefore = await countErrorPanels();
  const transcriptBefore = await transcriptText();
  for (const command of RETIRED_COMMANDS) {
    if (!MODEL_RETIRED_COMMANDS.includes(command)) {
      await expectRetiredCommandHint(command);
      continue;
    }
    const previous = await renderedAssistantText();
    result.calls += 1;
    result.tokens += estimateTokens(command);
    await sendPrompt(`${command} explain what you do`);
    await browser.waitUntil(
      async () => {
        const text = await renderedAssistantText();
        const errors = await countErrorPanels();
        return text.length > previous.length || errors > errorsBefore;
      },
      { timeout: 30_000, timeoutMsg: `${command} produced neither an answer nor an info panel` },
    );
    const errorsAfter = await countErrorPanels();
    if (errorsAfter > errorsBefore) {
      throw new Error(`${command} rendered an error panel`);
    }
    result.tokens += estimateTokens(await renderedAssistantText());
  }
  const transcriptAfter = await transcriptText();
  for (const command of RETIRED_COMMANDS) {
    if (!transcriptAfter.includes(command)) throw new Error(`${command} is missing from the transcript`);
  }
  if (transcriptAfter.length <= transcriptBefore.length) throw new Error("retired commands produced no transcript output");
  const sessions = await assertSessionsValid();
  if (sessions.files === 0) result.runnerNotes.push("retired-commands: no session JSONL was written yet");
}

/** A hinted retired command answers locally with an info panel and makes no model call. */
async function expectRetiredCommandHint(command: string): Promise<void> {
  const latestHint = async (): Promise<string> =>
    await browser.execute(() => {
      const panels = document.querySelectorAll(".agentic-chat-info:not(.agentic-chat-info-error)");
      return panels.length > 0 ? (panels[panels.length - 1].textContent ?? "") : "";
    });
  await sendPrompt(`${command} explain what you do`);
  await browser.waitUntil(async () => (await latestHint()).includes(`${command} was removed`), {
    timeout: 15_000,
    timeoutMsg: `${command} rendered no replacement hint`,
  });
}

async function runSteer(action: ChaosAction): Promise<void> {
  if (!plan.live) await setE2ERelease(false);
  const beforeAnswer = await renderedAssistantText();
  result.calls += modelCallsFor(action);
  result.tokens += estimateTokens(action.prompt ?? "");

  await sendPrompt(action.prompt ?? "");
  if (plan.live) {
    await browser.waitUntil(
      async () => (await browser.$$(".agentic-chat-step")).length > 0 || (await isRunning()),
      { timeout: 60_000, timeoutMsg: "the live steer prompt never started a tool call" },
    );
  } else {
    await waitForCall(`${action.id} tool`);
  }

  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(STEER_TEXT);
  await pressEnter();

  await browser.waitUntil(async () => (await input.getValue()) === "", {
    timeout: 10_000,
    timeoutMsg: "steering text was not cleared from the composer",
  });
  await browser.waitUntil(
    async () => (await $(".agentic-chat-status").getText()).includes("Queued for the active turn."),
    { timeout: 10_000, timeoutMsg: "steering status was not reported" },
  );

  if (!plan.live) await setE2ERelease(true);
  await waitForNewAnswer(beforeAnswer, 120_000);
  const transcript = await transcriptText();
  if (!transcript.includes(STEER_TEXT)) throw new Error("steering text is missing from the transcript");
  const steerIndex = transcript.indexOf(STEER_TEXT);
  const answerIndex = transcript.lastIndexOf("steered");
  if (answerIndex !== -1 && answerIndex < steerIndex) {
    throw new Error("the steered answer rendered before the steering text");
  }
  await assertSessionsValid();
}

async function runQueue(action: ChaosAction): Promise<void> {
  if (!plan.live) await setE2ERelease(false);
  const beforeAnswer = await renderedAssistantText();
  result.calls += modelCallsFor(action);
  result.tokens += estimateTokens(action.prompt ?? "");

  await sendPrompt(action.prompt ?? "");
  if (plan.live) await waitForRunning();
  else await waitForCall(`${action.id} held`);

  await sendWithButton(QUEUE_DRAFT);
  await browser.waitUntil(
    async () => (await $(".agentic-chat-send").getText()).trim() === "Update",
    { timeout: 10_000, timeoutMsg: "send button did not switch to queue/update mode" },
  );
  const input = await $(".agentic-chat-input");
  await input.setValue(QUEUE_EDITED);
  if ((await input.getValue()) !== QUEUE_EDITED) throw new Error("queued draft edit did not stick");

  if (!plan.live) await setE2ERelease(true);
  if (plan.live) {
    await waitForNewAnswer(beforeAnswer, 120_000);
  } else {
    await browser.waitUntil(
      async () => (await transcriptText()).includes("Queued answer used the edited draft."),
      { timeout: 60_000, timeoutMsg: "the queued scripted answer never rendered" },
    );
  }
  await browser.waitUntil(
    async () => (await $(".agentic-chat-send").getText()).trim() === "Send" || (await isRunning()),
    { timeout: 30_000, timeoutMsg: "the queued draft did not flush at turn end" },
  );
  const transcript = await transcriptText();
  if (!transcript.includes(QUEUE_EDITED)) throw new Error("the edited queued draft is missing from the transcript");
  if (transcript.includes(QUEUE_DRAFT)) throw new Error("the stale queued draft was sent");
  if (await isRunning()) {
    // A live model may answer the queued text with a tool or a question. The
    // draft was still sent; stop the follow-up turn so the next action is clean.
    result.runnerNotes.push("queue: the queued draft started a follow-up live turn; the driver stopped it after the assertion");
    await (await $(".agentic-chat-stop")).click();
    await browser.waitUntil(async () => !(await isRunning()), {
      timeout: 15_000,
      timeoutMsg: "the queued follow-up turn did not stop",
    });
  }
  await assertSessionsValid();
}

async function runStopSend(action: ChaosAction): Promise<void> {
  if (!plan.live) await setE2ERelease(false);
  const beforeAnswer = await renderedAssistantText();
  result.calls += modelCallsFor(action);
  result.tokens += estimateTokens(action.prompt ?? "");

  await sendPrompt(action.prompt ?? "");
  if (plan.live) await waitForRunning();
  else await waitForCall(`${action.id} held`);

  await sendWithButton(STOP_REPLACEMENT);
  const stopButton = await $(".agentic-chat-stop");
  await stopButton.waitForDisplayed({ timeout: 10_000 });
  await stopButton.click();
  await browser.waitUntil(async () => !(await $(".agentic-chat-stop").isDisplayed()), {
    timeout: 15_000,
    timeoutMsg: "the stopped turn never settled",
  });
  const input = await $(".agentic-chat-input");
  if ((await input.getValue()).trim() !== STOP_REPLACEMENT) {
    throw new Error("stop did not keep the queued replacement in the composer");
  }
  await browser.waitUntil(
    async () => (await $(".agentic-chat-send").getText()).trim() === "Send",
    { timeout: 10_000, timeoutMsg: "stop did not disarm the queued draft" },
  );
  await $(".agentic-chat-send").click();

  if (!plan.live) await setE2ERelease(true);
  await waitForNewAnswer(beforeAnswer, 120_000);
  const transcript = await transcriptText();
  if (transcript.includes("The stopped answer must not settle.")) {
    throw new Error("the stopped answer settled after stop");
  }
  if (!transcript.includes("Replacement answer after stop.") && !plan.live) {
    throw new Error("the replacement turn never rendered");
  }
  await assertSessionsValid();
}

async function runMaxTurns(action: ChaosAction): Promise<void> {
  await configureApproval("allow", { write: "deny" });
  try {
    result.calls += modelCallsFor(action);
    result.tokens += estimateTokens(action.prompt ?? "");
    await sendPrompt(action.prompt ?? "");
    const notice = /Turn cap: stopped after \d+ assistant turns/;
    let capSeen = true;
    try {
      await browser.waitUntil(async () => notice.test(await transcriptText()), {
        timeout: plan.live ? 180_000 : 120_000,
        interval: 1_000,
        timeoutMsg: "the assistant-turn cap produced no visible stop message",
      });
    } catch (error) {
      capSeen = false;
      if (!plan.live) throw error;
    }
    await browser.waitUntil(async () => !(await isRunning()), {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: "the UI is still running after the turn cap check",
    });
    if (!capSeen) {
      // A live model can refuse to loop. That is a precondition miss, not a
      // product failure: the dry run executes the full 25-turn budget and
      // observes the notice deterministically.
      result.runnerNotes.push(
        "max-turns: the live model stopped before the assistant-turn cap; the deterministic dry run proves the cap and notice",
      );
      await assertSessionsValid();
      return;
    }
    const responsive = await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
      if (!input) return false;
      input.focus();
      input.value = "responsiveness probe";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "responsiveness probe" }));
      return input.value === "responsiveness probe";
    });
    if (!responsive) throw new Error("the composer is not responsive after the turn cap fired");
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
      if (input) {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await assertSessionsValid();
  } finally {
    await configureApproval("ask");
  }
}

const PERSISTED = {
  noProxy: "localhost,127.0.0.1,chaos.local",
  requestTimeoutMs: 120_000,
  costAlertUsd: 2.5,
};

async function applyPersistedSettings(): Promise<void> {
  await openAgenticChatSettings();
  await selectSettingsTab("Models");
  await setSettingText("No proxy", PERSISTED.noProxy);
  await waitForAgenticChatSetting(
    (settings) => (settings.network as { noProxy?: string } | undefined)?.noProxy === PERSISTED.noProxy,
    "no-proxy setting did not persist",
  );
  await selectSettingsTab("Agent");
  await setSettingText("Request timeout (seconds)", String(PERSISTED.requestTimeoutMs / 1000));
  await waitForAgenticChatSetting(
    (settings) => settings.requestTimeoutMs === PERSISTED.requestTimeoutMs,
    "request timeout setting did not persist",
  );
  await selectSettingsTab("Advanced");
  await setSettingText("Cost alert (USD)", String(PERSISTED.costAlertUsd));
  await waitForAgenticChatSetting(
    (settings) => (settings.notifications as { costAlertUsd?: number } | undefined)?.costAlertUsd === PERSISTED.costAlertUsd,
    "cost alert setting did not persist",
  );
  await browser.pause(300);
  await closeAgenticChatSettings();
}

async function assertPersistedSettings(stage: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const settings = await readAgenticChatSettings<{
        network?: { noProxy?: string };
        requestTimeoutMs?: number;
        notifications?: { costAlertUsd?: number };
      }>();
      return (
        settings.network?.noProxy === PERSISTED.noProxy &&
        settings.requestTimeoutMs === PERSISTED.requestTimeoutMs &&
        settings.notifications?.costAlertUsd === PERSISTED.costAlertUsd
      );
    },
    { timeout: 10_000, timeoutMsg: `settings did not survive ${stage}` },
  );
  const stored = await browser.executeObsidian(async ({ app }, pluginId) => {
    const raw = await app.vault.adapter.read(`${app.vault.configDir}/plugins/${pluginId}/data.json`);
    return JSON.parse(raw) as {
      network?: { noProxy?: string };
      requestTimeoutMs?: number;
      notifications?: { costAlertUsd?: number };
    };
  }, "agentic-chat");
  if (
    stored.network?.noProxy !== PERSISTED.noProxy ||
    stored.requestTimeoutMs !== PERSISTED.requestTimeoutMs ||
    stored.notifications?.costAlertUsd !== PERSISTED.costAlertUsd
  ) {
    throw new Error(`data.json did not keep the values after ${stage}`);
  }
}

async function restoreSettings(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) return;
    const settings = plugin.settings as {
      network?: { noProxy?: string };
      requestTimeoutMs?: number;
      notifications?: { costAlertUsd?: number };
    };
    if (settings.network) settings.network.noProxy = "localhost,127.0.0.1,::1";
    settings.requestTimeoutMs = 90_000;
    if (settings.notifications) settings.notifications.costAlertUsd = 0;
    await plugin.saveSettings?.();
  });
}

async function reloadPlugin(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const pluginApi = (app as unknown as {
      plugins?: {
        disablePluginAndSave?: (id: string) => Promise<void>;
        enablePluginAndSave?: (id: string) => Promise<void>;
      };
    }).plugins;
    if (!pluginApi?.disablePluginAndSave || !pluginApi?.enablePluginAndSave) {
      throw new Error("Obsidian plugin API not available");
    }
    await pluginApi.disablePluginAndSave("agentic-chat");
    await pluginApi.enablePluginAndSave("agentic-chat");
  });
  await openChat();
}

/**
 * A full Obsidian renderer reload drops the WDIO Obsidian bridge, so this
 * harness cannot drive it. The persisted values are still read from data.json
 * (the same file a restart reads) and survived a plugin reload.
 */
async function runSettingsPersistence(action: ChaosAction): Promise<void> {
  await applyPersistedSettings();
  try {
    await assertPersistedSettings("the save");

    await reloadPlugin();
    await assertPersistedSettings("the plugin reload");
  } finally {
    await restoreSettings();
  }

  result.runnerNotes.push(
    "settings-persistence: a full Obsidian reload drops the WDIO Obsidian bridge, so persistence is proven with data.json (the restart source) plus a plugin reload",
  );
  void action;
}

async function runApprovalPaths(action: ChaosAction): Promise<void> {
  await configureApproval("ask");
  try {
    const before = await renderedAssistantText();
    result.calls += 2;
    result.tokens += estimateTokens("write the denied note");
    await sendPrompt(`Create the note ${DENIED_NOTE} with the content denied write.`);
    const denied = await approveIfPresent(30_000, false);
    if (!denied) throw new Error("the write approval modal never appeared for the deny path");
    await waitForNewAnswer(before, 120_000);
    if (await noteExists(DENIED_NOTE)) throw new Error("the denied note exists");

    const beforeAllowed = await renderedAssistantText();
    result.calls += 2;
    result.tokens += estimateTokens("write the allowed note");
    await sendPrompt(`Create the note ${ALLOWED_NOTE} with the content allowed write.`);
    const allowed = await approveIfPresent(30_000, true);
    if (!allowed) throw new Error("the write approval modal never appeared for the allow path");
    await waitForNewAnswer(beforeAllowed, 120_000);
    if (!(await noteExists(ALLOWED_NOTE))) throw new Error("the allowed note was not written");
    if (!(await readNote(ALLOWED_NOTE)).includes("allowed write")) {
      throw new Error("the allowed note has the wrong content");
    }
    result.notes.push({ path: DENIED_NOTE, exists: false });
    result.notes.push({ path: ALLOWED_NOTE, exists: true });
    void action;
  } finally {
    await configureApproval("ask");
  }
}

async function clickFirstInactiveSession(): Promise<boolean> {
  return await browser.execute(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-session-row"));
    const row = rows.find((candidate) => !candidate.classList.contains("is-active"));
    const main = row?.querySelector<HTMLElement>(".agentic-chat-session-main");
    if (!main) return false;
    main.click();
    return true;
  });
}

async function runSessionReload(action: ChaosAction): Promise<void> {
  const firstPrompt = "Session reload first prompt";
  const secondPrompt = "Session reload second prompt";
  result.calls += modelCallsFor(action);
  result.tokens += estimateTokens(firstPrompt) + estimateTokens(secondPrompt);

  const beforeFirst = await renderedAssistantText();
  await sendPrompt(firstPrompt);
  await waitForNewAnswer(beforeFirst, 120_000);

  await sendPrompt("/new");
  await browser.waitUntil(async () => !(await transcriptText()).includes("First session answer before the reload."), {
    timeout: 15_000,
    timeoutMsg: "/new did not clear the transcript",
  });

  const beforeSecond = await renderedAssistantText();
  await sendPrompt(secondPrompt);
  await waitForNewAnswer(beforeSecond, 120_000);

  await reloadPlugin();
  await browser.waitUntil(async () => (await transcriptText()).includes(secondPrompt), {
    timeout: 30_000,
    timeoutMsg: "the active transcript did not survive the plugin reload",
  });

  await sendPrompt("/sessions");
  await browser.waitUntil(
    async () => (await browser.$$(".agentic-chat-session-row")).length >= 2,
    { timeout: 15_000, timeoutMsg: "the session list did not show both conversations" },
  );
  const switched = await clickFirstInactiveSession();
  if (!switched) throw new Error("no inactive session row was found");
  await browser.waitUntil(async () => (await transcriptText()).includes(firstPrompt), {
    timeout: 30_000,
    timeoutMsg: "switching sessions did not restore the first transcript",
  });
  const sessions = await assertSessionsValid();
  if (sessions.files < 1) throw new Error("no session JSONL files were written");
  void action;
}

async function runLargeInput(action: ChaosAction): Promise<void> {
  if (!plan.live) await setE2ERelease(true);
  const huge = "chaos ".repeat(LARGE_INPUT_CHARS / 6);
  const before = await renderedAssistantText();
  result.calls += modelCallsFor(action);
  result.tokens += estimateTokens(huge);

  await sendPrompt(huge);
  await waitForNewAnswer(before, 120_000);

  const overflow = await browser.execute(() => {
    const composer = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
    const messages = document.querySelector<HTMLElement>(".agentic-chat-messages");
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      composer: composer ? composer.scrollWidth - composer.clientWidth : 0,
      messages: messages ? messages.scrollWidth - messages.clientWidth : 0,
    };
  });
  if (overflow.document > 2 || overflow.composer > 2 || overflow.messages > 2) {
    throw new Error(`horizontal overflow after large input: ${JSON.stringify(overflow)}`);
  }

  const beforeProbe = await renderedAssistantText();
  await sendPrompt("still responsive?");
  await waitForNewAnswer(beforeProbe, 60_000);
  void action;
}

async function readMcpSettingsServers(): Promise<Array<{ id: string; name: string; source?: string }>> {
  return await browser.executeObsidian(async ({ app }, pluginId) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: { mcp?: { servers?: Array<{ id: string; name: string; source?: string }> } } }> };
    }).plugins?.plugins?.[pluginId];
    return plugin?.settings?.mcp?.servers ?? [];
  }, "agentic-chat");
}

async function clickMcpHeaderButton(buttonText: string): Promise<boolean> {
  return await browser.execute((text) => {
    const headers = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-mcp-server-header"));
    for (const header of headers) {
      const buttons = Array.from(header.querySelectorAll<HTMLButtonElement>("button"));
      const button = buttons.find((candidate) => candidate.innerText.trim() === text);
      if (button) {
        button.click();
        return true;
      }
    }
    return false;
  }, buttonText);
}

async function runMcpLifecycle(action: ChaosAction): Promise<void> {
  await openAgenticChatSettings();
  await selectSettingsTab("Advanced");
  await setSettingToggle("Enable MCP", true);
  await waitForMcpAddRow();
  await setSettingTextByPlaceholder("Server name", "chaos-lifecycle");
  await setSettingTextByPlaceholder("https://mcp.example.com/mcp", "http://127.0.0.1:9/mcp");
  await clickMcpAddButton("Add MCP server");
  await browser.waitUntil(
    async () => (await browser.$$(".agentic-chat-mcp-server-header")).length > 0,
    { timeout: 15_000, timeoutMsg: "the MCP server row did not render" },
  );
  result.mcp.rendered = true;
  result.mcp.added = true;
  const rowText = await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-mcp-server-header"))
      .map((header) => header.textContent ?? "")
      .join("\n"),
  );
  if (!rowText.includes("chaos-lifecycle")) throw new Error("the added MCP server row is missing its name");
  const serversAfterAdd = await readMcpSettingsServers();
  if (serversAfterAdd.some((server) => server.name.includes("chaos-lifecycle") && server.source !== "plugin")) {
    throw new Error("the plugin-package server leaked into client-owned MCP settings");
  }

  const tested = await clickMcpHeaderButton("Test connection");
  if (!tested) throw new Error("the Test connection button was not found");
  await browser.waitUntil(
    async () => {
      const busy = await browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLButtonElement>(".agentic-chat-mcp-server-header button")).some(
          (button) => /testing|authenticating/i.test(button.innerText.trim()),
        ),
      );
      return !busy;
    },
    { timeout: 30_000, timeoutMsg: "the MCP test action never settled" },
  );
  const serversAfterTest = await readMcpSettingsServers();
  if (JSON.stringify(serversAfterTest) !== JSON.stringify(serversAfterAdd)) {
    throw new Error(`MCP settings changed after test: ${JSON.stringify(serversAfterTest)}`);
  }
  if ((await browser.$$(".agentic-chat-mcp-server-header")).length === 0) {
    throw new Error("the MCP server row disappeared after test");
  }

  // Plugin-declared servers own their endpoint, so the row's Remove button is
  // disabled by design; removing the package is the supported removal path.
  const removedPackage = await browser.executeObsidian(async ({ app }, pluginId) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<
          string,
          {
            pluginService?: {
              reload?: () => Promise<Array<{ name: string; rootPath: string }>>;
              removePackage?: (name: string, rootPath: string) => Promise<boolean>;
            };
          }
        >;
      };
    }).plugins?.plugins?.[pluginId];
    const service = plugin?.pluginService;
    if (!service?.reload || !service.removePackage) return false;
    const packages = await service.reload();
    const entry = packages.find((candidate) => candidate.name.startsWith("chaos-lifecycle"));
    if (!entry) return false;
    return await service.removePackage(entry.name, entry.rootPath);
  }, "agentic-chat");
  if (!removedPackage) throw new Error("the generated MCP package could not be removed");
  result.runnerNotes.push(
    "mcp-lifecycle: plugin-package servers are removed by deleting the package; their row-level Remove button is disabled by design",
  );

  await closeAgenticChatSettings();
  await openAgenticChatSettings();
  await selectSettingsTab("Advanced");
  await browser.waitUntil(
    async () => (await browser.$$(".agentic-chat-mcp-server-header")).length === 0,
    { timeout: 15_000, timeoutMsg: "the MCP server row did not disappear after removal" },
  );
  const serversAfterRemove = await readMcpSettingsServers();
  if (serversAfterRemove.some((server) => server.name.includes("chaos-lifecycle"))) {
    throw new Error(`removed MCP server is still in settings: ${JSON.stringify(serversAfterRemove)}`);
  }
  await setSettingToggle("Enable MCP", false);
  await browser.pause(300);
  await closeAgenticChatSettings();
  void action;
}

async function runAction(action: ChaosAction): Promise<void> {
  await mark(`step ${action.id}`);
  await logAction(action, "started");
  try {
    switch (action.kind) {
      case "settings":
        await runSettings();
        break;
      case "mcp":
        await runMcp();
        break;
      case "slash":
        await runSlash(action);
        break;
      case "retired-commands":
        await runRetiredCommands(action);
        break;
      case "steer":
        await runSteer(action);
        break;
      case "queue":
        await runQueue(action);
        break;
      case "stop-send":
        await runStopSend(action);
        break;
      case "max-turns":
        await runMaxTurns(action);
        break;
      case "settings-persistence":
        await runSettingsPersistence(action);
        break;
      case "approval-paths":
        await runApprovalPaths(action);
        break;
      case "session-reload":
        await runSessionReload(action);
        break;
      case "large-input":
        await runLargeInput(action);
        break;
      case "mcp-lifecycle":
        await runMcpLifecycle(action);
        break;
      default:
        await runPrompt(action);
    }
    result.steps.push({ id: action.id, surface: action.surface, status: "passed" });
    await logAction(action, "passed");
    await screenshot(action.id);
  } catch (error) {
    const message = errorText(error);
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

async function recordSkipped(step: Extract<ChaosBudgetStep, { status: "skipped" }>): Promise<void> {
  const detail = `skipped: ${step.reason}`;
  result.skippedSteps += 1;
  result.steps.push({ id: step.action.id, surface: step.action.surface, status: "skipped", detail });
  await logAction(step.action, "skipped", detail);
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
  const rows = await browser.execute(() => document.querySelectorAll(".agentic-chat-mcp-server-header").length);
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

let startedAt = Date.now();
let stopReason = "completed";
let plannedSteps: ChaosBudgetStep[] = [];
let plannedStopReason: "max-calls" | undefined;

describe("chaos monkey live driver", function () {
  this.timeout(900_000);

  before(async function () {
    plan = await loadPlan();
    if (plan.live && !apiKey) throw new Error("live plan needs AGENTIC_CHAT_API_KEY");
    this.timeout(Math.max(60_000, plan.caps.maxSeconds * 1000 + 120_000));
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
      skippedSteps: 0,
      assistantChars: 0,
      settingsToggled: false,
      notes: [],
      runnerNotes: [],
      mcp: { rendered: false, added: false },
      clock: { startedAt, finishedAt: startedAt },
      caps: plan.caps,
    };

    if (plan.mode === "explore") {
      if (!plan.live) await installScriptedTurns(dryReplayTurns(400));
      await configurePlugin({
        provider: plan.live ? "openai-compatible" : "openrouter",
        openrouterApiKey: plan.live ? undefined : "e2e-scripted-key",
        openaiCompatibleApiKey: plan.live ? apiKey : undefined,
        openaiCompatibleBaseUrl: plan.live ? plan.baseUrl : undefined,
        openaiCompatibleModel: plan.live ? plan.model : undefined,
        requestTimeoutMs: 120_000,
        maxNetworkRetries: 1,
        mode: "safe",
        approval: { mutating: "ask", perTool: {} },
        web: { enabled: false },
      });
      await openChat();
      await mark("chat open");
      return;
    }

    let sequence =
      plan.mode === "focused" ? focusedSequence(plan.target ?? "composer") : genericSequence(plan.caps, plan.seed);
    if (sequence.length > plan.caps.maxSteps) sequence = sequence.slice(0, plan.caps.maxSteps);

    // Reserve each action's full call estimate before the run. Actions that do
    // not fit are skipped; scripted dry runs install turns only for the actions
    // that will actually run, so a skip cannot desync the replay stream.
    const budget = planChaosBudget(sequence, plan.caps.maxCalls);
    plannedSteps = budget.steps;
    plannedStopReason = budget.stopReason;
    if (!plan.live) {
      const runnable = plannedSteps.filter((step) => step.status === "run").map((step) => step.action);
      await installScriptedTurns(scriptedTurnsFor(runnable) as ScriptedTurn[]);
    }

    await configurePlugin({
      provider: plan.live ? "openai-compatible" : "openrouter",
      openrouterApiKey: plan.live ? undefined : "e2e-scripted-key",
      openaiCompatibleApiKey: plan.live ? apiKey : undefined,
      openaiCompatibleBaseUrl: plan.live ? plan.baseUrl : undefined,
      openaiCompatibleModel: plan.live ? plan.model : undefined,
      requestTimeoutMs: 120_000,
      maxNetworkRetries: 0,
      mode: "safe",
      approval: { mutating: "ask", perTool: {} },
      web: { enabled: false },
    });
    await openChat();
    await mark("chat open");
  });

  after(async function () {
    if (!result) return;
    result.clock.finishedAt = Date.now();
    result.stopReason = stopReason;
    const executed = result.steps.filter((step) => step.status !== "skipped");
    result.verdict =
      executed.length === 0
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
        skippedSteps: result.skippedSteps,
        findings: result.findings.length,
        calls: result.calls,
        estimatedTokens: result.tokens,
        stopReason: result.stopReason,
        verdict: result.verdict,
      });
      await copySessions(outDir).catch(() => undefined);
    }

    try {
      await withHangTimeout(closeAgenticChatSettings(), 15_000, "close settings");
    } catch {
      // Settings may already be closed, or Obsidian stopped answering.
    }
  });

  it("drives the planned surfaces under the hard caps", async function () {
    this.timeout(Math.max(60_000, plan.caps.maxSeconds * 1000 + 300_000));
    if (plan.mode === "explore") {
      await sessionDirPath(); // fill the cache while Obsidian answers
      const outcome = await runExplorer({
        plan,
        apiKey,
        outDir,
        startedAt,
        scenarioNames: [...EXPLORER_SCENARIOS],
        runScenario: runScenarioForExplorer,
        sessionDir: sessionDirPath,
        assertSessionsValid,
      });
      result.steps = outcome.steps;
      result.findings.push(...outcome.findings.map(({ severity, step, message, source }) => ({ severity, step, message: `[${source}] ${message}` })));
      result.calls = outcome.calls;
      result.tokens = outcome.tokens;
      result.explorer = outcome.explorer;
      result.plugin = outcome.plugin;
      stopReason = outcome.stopReason;
      expect(result.steps.length).toBeGreaterThan(0);
      return;
    }
    for (const step of plannedSteps) {
      const stop = checkBudget();
      if (stop) {
        stopReason = stop;
        break;
      }
      if (step.status === "skipped") {
        await recordSkipped(step);
        continue;
      }
      await runAction(step.action);
      if (stopReason.startsWith("repeated")) break;
    }

    // The plan already reserved every run action. It stops with max-calls only
    // when nothing left in the sequence fits; a later runtime cap can still
    // stop the run first.
    if (plannedStopReason && stopReason === "completed") stopReason = plannedStopReason;
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
  const sessionDir = await sessionDirPath();
  if (!sessionDir || !existsSync(sessionDir)) return;
  const files = await readdir(sessionDir);
  const destination = path.join(target, "sessions");
  await mkdir(destination, { recursive: true });
  for (const file of files.filter((entry) => entry.endsWith(".jsonl"))) {
    await copyFile(path.join(sessionDir, file), path.join(destination, file));
  }
}
