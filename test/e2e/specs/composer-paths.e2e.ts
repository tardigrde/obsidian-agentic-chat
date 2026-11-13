import { browser, expect, $ } from "@wdio/globals";
import { after, before, beforeEach, describe, it } from "mocha";
import {
  installScriptedTurns,
  readTurn,
  releaseScriptedTurns,
  scriptedCallLabels,
  textTurn,
} from "../support/scripted-stream";

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
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
      approval: { mutating: string; perTool: Record<string, string> };
      web: { enabled: boolean };
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "e2e-scripted-key";
    settings.mode = "safe";
    settings.approval.mutating = "allow";
    settings.approval.perTool = {};
    settings.web.enabled = false;
    await plugin.saveSettings?.();
    return true;
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
      {
        label: "thinking then error",
        content: [{ type: "thinking", thinking: "I should check the config first." }],
        stopReason: "error",
        errorMessage: "Provider connection lost mid-stream.",
        emitUpdates: true,
      },
    ]);

    const configured = await configurePlugin();
    if (!configured) throw new Error("agentic-chat plugin not found in the test vault");
    await openChat();
  });

  after(async function () {
    await releaseScriptedTurns(true);
  });

  beforeEach(async function () {
    await releaseScriptedTurns(false);
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

    await releaseScriptedTurns(true);

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

    await releaseScriptedTurns(true);

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

  it("keeps the reasoning trace of a failed turn, live and after a history re-render", async function () {
    await sendWithButton("think, then fail");
    await browser.waitUntil(
      async () => (await transcriptText()).includes("Provider connection lost mid-stream."),
      { timeout: 10_000, timeoutMsg: "the scripted error never rendered" },
    );
    const readTrace = async () =>
      await browser.execute(() => {
        const banner = Array.from(document.querySelectorAll(".agentic-chat-assistant .agentic-chat-error")).pop();
        const turn = banner?.closest(".agentic-chat-assistant");
        return Array.from(turn?.querySelectorAll(".agentic-chat-reasoning-body") ?? []).map((body) => (body.textContent ?? "").trim());
      });
    await browser.pause(300);
    expect(await readTrace()).toEqual(["I should check the config first."]);
    // History replay renders the same turn in one synchronous block.
    await browser.executeObsidian(({ app }) => {
      const leaf = app.workspace.getLeavesOfType("agentic-chat-chat-view")[0];
      const view = leaf?.view as unknown as { renderTranscript: (m: unknown[]) => void; service: { getMessages: () => unknown[] } };
      view.renderTranscript(view.service.getMessages());
    });
    await browser.pause(300);
    expect(await readTrace()).toEqual(["I should check the config first."]);
  });

  it("shows a failed turn's error without an empty green Thought pill", async function () {
    // Every scripted turn is used, so the next request fails at the provider.
    await sendWithButton("no scripted turn is left for this prompt");
    const error = await $(".agentic-chat-assistant .agentic-chat-error");
    await error.waitForExist({ timeout: 10_000 });
    const bubble = await browser.execute(() => {
      const banner = Array.from(document.querySelectorAll(".agentic-chat-assistant .agentic-chat-error")).pop();
      const turn = banner?.closest(".agentic-chat-assistant");
      const pills = Array.from(turn?.querySelectorAll(".agentic-chat-reasoning") ?? []);
      return {
        bannerText: banner?.textContent ?? "",
        emptyPills: pills.filter((pill) => !pill.querySelector(".agentic-chat-reasoning-body")?.textContent?.trim()).length,
      };
    });
    expect(bubble.bannerText.length).toBeGreaterThan(0);
    expect(bubble.emptyPills).toBe(0);
  });
});

