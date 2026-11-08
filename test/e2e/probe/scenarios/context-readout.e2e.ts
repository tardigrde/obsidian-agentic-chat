import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { mark, writeMetrics } from "../../support/record";
import {
  configurePlugin,
  installScriptedTurns,
  openChat,
  sendPrompt,
  waitForNewAssistantText,
} from "../support/probe-helpers";

/**
 * Deterministic probe: the context readout must show the full next-request load
 * (transcript + system prompt + active tool schemas + response reserve), not the
 * transcript alone. Scripted turns keep it offline.
 */
describe("probe: context readout", function () {
  this.timeout(120_000);

  before(async function () {
    await configurePlugin({
      provider: "openrouter",
      openrouterApiKey: "probe-scripted-key",
      mode: "safe",
      approval: { mutating: "allow", perTool: {} },
      web: { enabled: false },
    });
    await installScriptedTurns([
      { label: "context readout", stopReason: "stop", content: [{ type: "text", text: "Context readout answer." }] },
    ]);
    await openChat();
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

  it("shows the full-load percentage with a section breakdown", async function () {
    await mark("1 chat open");
    const bar = await $(".agentic-chat-ctx-bar");
    const percentEl = await $(".agentic-chat-ctx-percent");
    // The readout stays hidden until a transcript exists.
    expect(await bar.isDisplayed()).toBe(false);

    await sendPrompt("hello context readout");
    await waitForNewAssistantText("");
    await browser.waitUntil(async () => await bar.isDisplayed(), {
      timeout: 10_000,
      timeoutMsg: "the context bar never appeared after the first turn",
    });
    await mark("2 first turn completed; context bar visible");

    const percentText = (await percentEl.getText()).trim();
    expect(percentText).toMatch(/^\d+%$/);
    const title = await bar.getAttribute("title");
    expect(title).toContain("Transcript");
    expect(title).toContain("system prompt and loaded skills");
    expect(title).toContain("active tool schemas");
    expect(title).toContain("response reserve");

    const state = await browser.executeObsidian(async ({ app }) => {
      const view = app.workspace.getLeavesOfType("agentic-chat-chat-view")[0]?.view as unknown as {
        service?: { getContextReadout?: () => unknown };
      };
      return view?.service?.getContextReadout?.() ?? null;
    });
    const readout = state as {
      fraction: number;
      contextWindow: number;
      load: {
        transcriptTokens: number;
        systemPromptTokens: number;
        toolSchemaTokens: number;
        reserveTokens: number;
        totalTokens: number;
      };
    } | null;

    expect(readout).not.toBeNull();
    expect(readout!.load.systemPromptTokens).toBeGreaterThan(0);
    expect(readout!.load.toolSchemaTokens).toBeGreaterThan(0);
    expect(readout!.load.reserveTokens).toBe(1_000);
    expect(readout!.load.totalTokens).toBe(
      readout!.load.transcriptTokens +
        readout!.load.systemPromptTokens +
        readout!.load.toolSchemaTokens +
        readout!.load.reserveTokens,
    );
    // The honest value is larger than the old transcript-only fraction.
    expect(readout!.fraction).toBeGreaterThan(readout!.load.transcriptTokens / readout!.contextWindow);
    expect(Number.parseInt(percentText, 10)).toBe(Math.round(readout!.fraction * 100));

    await writeMetrics({
      percent: Number.parseInt(percentText, 10),
      title,
      contextWindow: readout!.contextWindow,
      load: readout!.load,
    });
    await mark("3 full-load value and breakdown asserted");
    await browser.pause(1_200);
  });
});
