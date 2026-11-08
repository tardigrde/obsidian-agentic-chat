import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { expectNoHorizontalOverflow, expectWithinViewport } from "../../support/layout";
import { mark, writeMetrics } from "../../support/record";
import {
  configurePlugin,
  installScriptedTurns,
  openChat,
  sendPrompt,
  waitForNewAssistantText,
} from "../support/probe-helpers";

const HELD_TURN_MS = 3_500;
const STOP_TURN_MS = 9_000;
const NARROW_VIEWPORT = (process.env.AGENTIC_CHAT_E2E_WINDOW_SIZE ?? "").startsWith("390x");

async function applyNarrowViewport(): Promise<void> {
  if (!NARROW_VIEWPORT) return;
  const cdpBrowser = browser as typeof browser & {
    cdp?: (domain: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  if (cdpBrowser.cdp) {
    await cdpBrowser.cdp("Emulation", "setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  await browser.waitUntil(async () => (await browser.execute(() => window.innerWidth)) <= 400, {
    timeout: 5_000,
    timeoutMsg: "the probe did not enter the narrow desktop viewport",
  });
}

function textTurn(label: string, text: string, delayMs = 0) {
  return { label, stopReason: "stop" as const, content: [{ type: "text" as const, text }], delayMs };
}

async function pressEnter(): Promise<void> {
  await browser.keys("Enter");
}

async function waitForSendButton(label: string): Promise<void> {
  await browser.waitUntil(async () => (await $(".agentic-chat-send").getText()).trim() === label, {
    timeout: 10_000,
    timeoutMsg: `send button never showed ${label}`,
  });
}

async function waitForTranscript(text: string): Promise<void> {
  await browser.waitUntil(async () => (await $(".agentic-chat-messages").getText()).includes(text), {
    timeout: 20_000,
    timeoutMsg: `transcript never contained ${text}`,
  });
}

async function setComposer(value: string): Promise<void> {
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(value);
}

/**
 * Scripted probe: records the four composer paths in one run.
 * Send, steer after a tool call, queue until turn end, and stop-then-send.
 */
describe("probe: composer paths", function () {
  this.timeout(180_000);

  before(async function () {
    await configurePlugin({
      provider: "openrouter",
      openrouterApiKey: "probe-scripted-key",
      mode: "safe",
      approval: { mutating: "allow", perTool: {} },
      web: { enabled: false },
    });
    await installScriptedTurns([
      textTurn("idle send", "Idle send answer."),
      textTurn("steer initial", "Initial steer answer.", HELD_TURN_MS),
      textTurn("steer final", "Steered answer used the added constraint."),
      textTurn("queue initial", "Initial queued answer.", HELD_TURN_MS),
      textTurn("queue final", "Queued answer used the edited draft."),
      textTurn("stop initial", "The stopped answer must not settle.", STOP_TURN_MS),
      textTurn("stop replacement", "Replacement answer after stop."),
    ]);
    await openChat();
    await applyNarrowViewport();
  });

  after(async function () {
    await browser.execute(() => {
      const target = window as typeof window & {
        __AGENTIC_CHAT_E2E_TURNS__?: unknown;
        __AGENTIC_CHAT_E2E_CALLS__?: number;
        __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[];
      };
      delete target.__AGENTIC_CHAT_E2E_TURNS__;
      delete target.__AGENTIC_CHAT_E2E_CALLS__;
      delete target.__AGENTIC_CHAT_E2E_CALL_LOG__;
    });
  });

  it("records send, steer, queue, and stop-then-send", async function () {
    await mark("1 composer idle");
    await expectNoHorizontalOverflow(".agentic-chat-view");
    await expectWithinViewport(".agentic-chat-input");

    // 1. Enter while idle sends.
    await setComposer("idle send prompt");
    await pressEnter();
    const first = await waitForNewAssistantText("");
    expect(first).toContain("Idle send answer.");
    await mark("2 Enter while idle sent the prompt");
    await browser.pause(800);

    // 2. Enter while the agent runs steers the active turn.
    await setComposer("steer start prompt");
    await pressEnter();
    await waitForSendButton("Queue");
    await mark("3 agent running; send button is Queue");
    await setComposer("keep the answer concise");
    await pressEnter();
    await browser.waitUntil(async () => (await (await $(".agentic-chat-input")).getValue()) === "", {
      timeout: 5_000,
      timeoutMsg: "steering text was not cleared",
    });
    await mark("4 Enter while running submitted steering text");
    const steered = await waitForNewAssistantText(first);
    expect(steered).toContain("Steered answer used the added constraint.");
    await mark("5 steered answer arrived in the same turn");
    await browser.pause(1_200);

    // 3. Queue holds the draft until the active turn ends.
    await setComposer("queue start prompt");
    await pressEnter();
    await waitForSendButton("Queue");
    await mark("6 agent running; queue a draft");
    await sendPrompt("queued draft before edit");
    await waitForSendButton("Update");
    await setComposer("queued draft after edit");
    await mark("7 Queue holds the edited draft");
    const queued = await waitForNewAssistantText(steered);
    expect(queued).toContain("Queued answer used the edited draft.");
    const transcriptAfterQueue = await $(".agentic-chat-messages").getText();
    expect(transcriptAfterQueue).not.toContain("queued draft before edit");
    await mark("8 queued draft sent after the turn ended");
    await browser.pause(1_200);

    // 4. Stop, then send replaces the turn.
    await setComposer("stop start prompt");
    await pressEnter();
    await waitForSendButton("Queue");
    await sendPrompt("replacement prompt");
    await waitForSendButton("Update");
    await mark("9 queue a replacement draft");
    const stop = await $(".agentic-chat-stop");
    await stop.waitForDisplayed({ timeout: 5_000 });
    await stop.click();
    await browser.waitUntil(async () => !(await $(".agentic-chat-stop").isDisplayed()), {
      timeout: 10_000,
      timeoutMsg: "the stopped turn never settled",
    });
    expect(await (await $(".agentic-chat-input")).getValue()).toBe("replacement prompt");
    await waitForSendButton("Send");
    await mark("10 stopped; draft kept for a replacement send");
    await $(".agentic-chat-send").click();
    await waitForTranscript("Replacement answer after stop.");
    const transcript = await $(".agentic-chat-messages").getText();
    expect(transcript).not.toContain("The stopped answer must not settle.");
    await mark("11 replacement turn answered after stop");

    await writeMetrics({
      mode: "scripted",
      paths: ["send", "steer", "queue", "stop-then-send"],
      heldTurnMs: HELD_TURN_MS,
      stopTurnMs: STOP_TURN_MS,
      transcriptChars: transcript.length,
    });

    await browser.pause(1_500);
  });
});
