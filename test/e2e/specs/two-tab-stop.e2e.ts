import { browser, expect, $ } from "@wdio/globals";
import { after, before, describe, it } from "mocha";

type ScriptedTurn = {
  label?: string;
  content: Array<Record<string, unknown>>;
  stopReason?: "stop" | "toolUse";
  delayMs?: number;
};

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
    };
    target.__AGENTIC_CHAT_E2E_TURNS__ = scriptedTurns;
    target.__AGENTIC_CHAT_E2E_CALLS__ = 0;
    target.__AGENTIC_CHAT_E2E_CALL_LOG__ = [];
  }, turns);
}

async function configureSafe(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("plugin not found");
    const s = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      mode: string;
      approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
    };
    s.provider = "openrouter";
    s.openrouterApiKey = "e2e-scripted-key";
    s.mode = "safe";
    s.approval.mutating = "ask";
    s.approval.perTool = {};
    s.approval.workingDirs = [];
    await plugin.saveSettings?.();
  });
}

async function sendPrompt(text: string): Promise<void> {
  await browser.execute((msg) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
    const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
    if (!textarea || !send) throw new Error("composer missing");
    textarea.value = msg;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    send.click();
  }, text);
}

async function selectTab(index: number): Promise<void> {
  await browser.execute((target) => {
    document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[target]?.click();
  }, index);
  await browser.waitUntil(
    async () =>
      await browser.execute((target) => {
        return document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[target]?.classList.contains("is-active");
      }, index),
    { timeout: 2_000 },
  );
}

async function waitForComposerIdle(): Promise<void> {
  await browser.waitUntil(async () => (await $(".agentic-chat-send").getText()).trim() === "Send", {
    timeout: 10_000,
    timeoutMsg: "the composer did not become idle",
  });
}

/** True while the tab's agent is streaming. */
async function streamStates(): Promise<boolean[]> {
  return await browser.executeObsidian(async ({ app }) => {
    const view = app.workspace.getLeavesOfType("agentic-chat-chat-view")[0]?.view as unknown as {
      tabs: Array<{ service: { isStreaming: () => boolean } }>;
    };
    return view.tabs.map((tab) => tab.service.isStreaming());
  });
}

/** The tab service's persisted conversation, as text. */
async function tabTranscript(index: number): Promise<string> {
  return await browser.executeObsidian(async ({ app }, target) => {
    const view = app.workspace.getLeavesOfType("agentic-chat-chat-view")[0]?.view as unknown as {
      tabs: Array<{ service: { getMessages: () => unknown[] } }>;
    };
    return JSON.stringify(view.tabs[target]?.service.getMessages() ?? []);
  }, index);
}

async function abortTab(index: number): Promise<void> {
  await browser.executeObsidian(async ({ app }, target) => {
    const view = app.workspace.getLeavesOfType("agentic-chat-chat-view")[0]?.view as unknown as {
      tabs: Array<{ service: { abort: () => void } }>;
    };
    view.tabs[target]?.service.abort();
  }, index);
}

describe("two-tab Stop", function () {
  before(async function () {
    await installScriptedTurns([
      {
        label: "tab one slow",
        stopReason: "stop",
        delayMs: 12_000,
        content: [{ type: "text", text: "Tab one finished" }],
      },
      {
        label: "tab two slow",
        stopReason: "stop",
        delayMs: 6_000,
        content: [{ type: "text", text: "Tab two should stop" }],
      },
    ]);
    await configureSafe();
    await openChat();
  });

  it("stopping one tab does not abort the other tab's turn", async function () {
    await selectTab(0);
    await waitForComposerIdle();
    await sendPrompt("start tab one slow turn");
    const tabOneStop = await $(".agentic-chat-stop");
    await tabOneStop.waitForDisplayed({ timeout: 5_000, timeoutMsg: "tab one never started streaming" });
    // The new tab's stream controller snapshots the call counter at construction.
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          return (window as typeof window & { __AGENTIC_CHAT_E2E_CALLS__?: number }).__AGENTIC_CHAT_E2E_CALLS__ ?? 0;
        }) >= 1,
      { timeout: 5_000, timeoutMsg: "tab one's scripted call did not start" },
    );

    // Create the second tab after tab one's call is in flight, so its service
    // starts at the second scripted turn instead of reusing the first.
    await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-tab-add")?.click());
    await browser.waitUntil(
      async () =>
        ((await browser.execute(
          () => document.querySelectorAll<HTMLElement>(".agentic-chat-tab").length,
        )) as unknown as number) >= 2,
      { timeout: 5_000 },
    );
    await browser.pause(1_000);

    await selectTab(1);
    await waitForComposerIdle();
    await sendPrompt("start tab two slow turn");

    await browser.waitUntil(
      async () => {
        const states = await streamStates();
        return states[0] === true && states[1] === true;
      },
      { timeout: 5_000, timeoutMsg: "both tabs did not have a turn in flight" },
    );

    const stop = await $(".agentic-chat-stop");
    await stop.waitForDisplayed({ timeout: 5_000 });
    await stop.click();

    // Tab two's scripted answer is due at 6s. If Stop did nothing, it lands.
    await selectTab(1);
    await browser.pause(7_000);
    expect(await tabTranscript(1)).not.toContain("Tab two should stop");

    // Tab one was never stopped; its answer must still arrive.
    await selectTab(0);
    await browser.waitUntil(
      async () => (await tabTranscript(0)).includes("Tab one finished"),
      { timeout: 15_000, timeoutMsg: "the untouched tab's turn did not finish" },
    );

    // Leave no stream running for the next spec.
    await abortTab(0);
    await browser.waitUntil(
      async () => {
        const states = await streamStates();
        return states[0] === false;
      },
      { timeout: 10_000, timeoutMsg: "tab one did not settle after cleanup" },
    );
  });

  after(async function () {
    await browser.execute(() => {
      const target = window as typeof window & {
        __AGENTIC_CHAT_E2E_TURNS__?: unknown;
        __AGENTIC_CHAT_E2E_CALLS__?: unknown;
        __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown;
      };
      delete target.__AGENTIC_CHAT_E2E_TURNS__;
      delete target.__AGENTIC_CHAT_E2E_CALLS__;
      delete target.__AGENTIC_CHAT_E2E_CALL_LOG__;
    });
  });
});
