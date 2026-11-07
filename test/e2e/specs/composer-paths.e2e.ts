import { browser, expect, $ } from "@wdio/globals";
import { after, before, beforeEach, describe, it } from "mocha";

type ScriptedTurn = {
  label?: string;
  content: Array<Record<string, unknown>>;
  stopReason?: "stop" | "length" | "toolUse";
  delayMs?: number;
  emitUpdates?: boolean;
  hold?: boolean;
};

function textTurn(label: string, text: string, options: Omit<Partial<ScriptedTurn>, "label" | "content"> = {}): ScriptedTurn {
  return {
    ...options,
    label,
    stopReason: "stop",
    content: [{ type: "text", text }],
  };
}

function readTurn(label: string, path: string, options: Omit<Partial<ScriptedTurn>, "label" | "content"> = {}): ScriptedTurn {
  return {
    ...options,
    label,
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: `e2e-${label}`, name: "read", arguments: { path } }],
  };
}

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

async function installScriptedTurns(turns: ScriptedTurn[]): Promise<void> {
  await browser.execute((scriptedTurns) => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_TURNS__?: ScriptedTurn[];
      __AGENTIC_CHAT_E2E_CALLS__?: number;
      __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[];
      __AGENTIC_CHAT_E2E_RELEASE__?: boolean;
    };
    target.__AGENTIC_CHAT_E2E_TURNS__ = scriptedTurns;
    target.__AGENTIC_CHAT_E2E_CALLS__ = 0;
    target.__AGENTIC_CHAT_E2E_CALL_LOG__ = [];
    target.__AGENTIC_CHAT_E2E_RELEASE__ = false;
  }, turns);
}

async function setE2ERelease(release: boolean): Promise<void> {
  await browser.execute((value) => {
    const target = window as typeof window & { __AGENTIC_CHAT_E2E_RELEASE__?: boolean };
    target.__AGENTIC_CHAT_E2E_RELEASE__ = value;
  }, release);
}

async function configurePlugin(): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) return false;
    const settings = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      mode: string;
      approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
      web: { enabled: boolean };
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "e2e-scripted-key";
    settings.mode = "safe";
    settings.approval.mutating = "allow";
    settings.approval.perTool = {};
    settings.approval.workingDirs = [];
    settings.web.enabled = false;
    await plugin.saveSettings?.();
    return true;
  });
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
    timeout: 10_000,
    timeoutMsg: `scripted call ${label} never started`,
  });
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

async function transcriptText(): Promise<string> {
  return await $(".agentic-chat-messages").getText();
}

function assertOrdered(transcript: string, parts: string[]): void {
  let cursor = -1;
  for (const part of parts) {
    const index = transcript.indexOf(part);
    if (index === -1) throw new Error(`transcript is missing ${JSON.stringify(part)}:\n${transcript}`);
    if (index <= cursor) throw new Error(`transcript order is wrong at ${JSON.stringify(part)}:\n${transcript}`);
    cursor = index;
  }
}

describe("agentic-chat composer paths", function () {
  before(async function () {
    await installScriptedTurns([
      textTurn("idle send", "Idle send answer."),
      // Hold a tool-call turn so the user can steer before the tool runs. The
      // steering queue drains only after this successful tool batch completes.
      readTurn("steer tool", "Welcome.md", { emitUpdates: true, hold: true }),
      textTurn("steer final", "Steered answer used the added constraint."),
      textTurn("queue held", "Initial queued answer.", { hold: true }),
      textTurn("queue final", "Queued answer used the edited draft."),
      textTurn("stop held", "The stopped answer must not settle.", { delayMs: 15_000 }),
      textTurn("stop replacement", "Replacement answer after stop."),
    ]);

    const configured = await configurePlugin();
    if (!configured) throw new Error("agentic-chat plugin not found in the test vault");
    await openChat();
  });

  after(async function () {
    await setE2ERelease(true);
  });

  beforeEach(async function () {
    await setE2ERelease(false);
  });

  it("sends with Enter while the agent is idle", async function () {
    const input = await $(".agentic-chat-input");
    await input.click();
    await input.setValue("idle send prompt");
    await pressEnter();

    await browser.waitUntil(async () => (await transcriptText()).includes("Idle send answer."), {
      timeout: 10_000,
      timeoutMsg: "idle Enter send never rendered the scripted answer",
    });
    expect(await input.getValue()).toBe("");
    assertOrdered(await transcriptText(), ["idle send prompt", "Idle send answer."]);
    expect(await scriptedCallLabels()).toEqual(["idle send"]);
  });

  it("steers after a successful tool call while the agent is running", async function () {
    await sendWithButton("steer start prompt");
    await waitForCall("steer tool");

    const input = await $(".agentic-chat-input");
    await input.click();
    await input.setValue("keep the answer concise");
    await pressEnter();

    await browser.waitUntil(async () => (await input.getValue()) === "", {
      timeout: 5_000,
      timeoutMsg: "steering text was not cleared from the composer",
    });
    await browser.waitUntil(
      async () => (await $(".agentic-chat-status").getText()).includes("Queued for the active turn."),
      { timeout: 5_000, timeoutMsg: "steering status was not reported" },
    );
    expect(await scriptedCallLabels()).toEqual(["idle send", "steer tool"]);

    await setE2ERelease(true);

    await browser.waitUntil(async () => (await transcriptText()).includes("Steered answer used the added constraint."), {
      timeout: 10_000,
      timeoutMsg: "steered scripted answer did not render",
    });
    assertOrdered(await transcriptText(), [
      "steer start prompt",
      "Read: Welcome.md",
      "keep the answer concise",
      "Steered answer used the added constraint.",
    ]);
    expect(await scriptedCallLabels()).toEqual(["idle send", "steer tool", "steer final"]);
  });

  it("holds the Queue action until the active turn ends", async function () {
    await sendWithButton("queue start prompt");
    await waitForCall("queue held");

    await sendWithButton("queued draft before edit");
    await browser.waitUntil(
      async () => (await $(".agentic-chat-send").getText()).trim() === "Update",
      { timeout: 5_000, timeoutMsg: "send button did not switch to update mode" },
    );

    const input = await $(".agentic-chat-input");
    await input.setValue("queued draft after edit");
    expect(await input.getValue()).toBe("queued draft after edit");

    await setE2ERelease(true);

    await browser.waitUntil(async () => (await transcriptText()).includes("Queued answer used the edited draft."), {
      timeout: 10_000,
      timeoutMsg: "queued scripted answer did not render",
    });
    const transcript = await transcriptText();
    expect(transcript).not.toContain("queued draft before edit");
    assertOrdered(transcript, ["queue start prompt", "Initial queued answer.", "queued draft after edit", "Queued answer used the edited draft."]);
    expect(await scriptedCallLabels()).toEqual(["idle send", "steer tool", "steer final", "queue held", "queue final"]);
  });

  it("stops, then sends the draft as a replacement turn", async function () {
    await sendWithButton("stop start prompt");
    await waitForCall("stop held");

    // Arm the Queue action first, then stop. The held draft must not auto-send.
    await sendWithButton("replacement after stop");
    const stopButton = await $(".agentic-chat-stop");
    await stopButton.waitForDisplayed({ timeout: 5_000 });
    await stopButton.click();

    await browser.waitUntil(
      async () => !(await $(".agentic-chat-stop").isDisplayed()),
      { timeout: 5_000, timeoutMsg: "the stopped turn never settled" },
    );
    const input = await $(".agentic-chat-input");
    expect(await input.getValue()).toBe("replacement after stop");
    await browser.waitUntil(
      async () => (await $(".agentic-chat-send").getText()).trim() === "Send",
      { timeout: 5_000, timeoutMsg: "stop did not disarm the queued draft" },
    );

    await $(".agentic-chat-send").click();

    await browser.waitUntil(async () => (await transcriptText()).includes("Replacement answer after stop."), {
      timeout: 10_000,
      timeoutMsg: "replacement turn after stop never rendered",
    });
    const transcript = await transcriptText();
    expect(transcript).not.toContain("The stopped answer must not settle.");
    assertOrdered(transcript, ["stop start prompt", "replacement after stop", "Replacement answer after stop."]);
    expect(await scriptedCallLabels()).toEqual([
      "idle send",
      "steer tool",
      "steer final",
      "queue held",
      "queue final",
      "stop held",
      "stop replacement",
    ]);
  });

  it("inserts a newline with Shift+Enter without sending", async function () {
    const input = await $(".agentic-chat-input");
    await input.click();
    await input.setValue("line one");
    await browser.keys(["Shift", "Enter"]);

    const value = await input.getValue();
    expect(value).toContain("\n");
    expect(value.trim()).toBe("line one");
    // No new scripted call: Shift+Enter must not submit the draft.
    expect(await scriptedCallLabels()).toHaveLength(7);

    await input.clearValue();
  });
});
