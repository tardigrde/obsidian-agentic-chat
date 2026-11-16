import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import {
  expectNoHorizontalOverflow,
  expectWithinViewport,
} from "../../support/layout";
import { mark, writeMetrics } from "../../support/record";
import {
  configurePlugin,
  installScriptedTurns,
  openChat,
  sendPrompt,
  waitForScriptedCalls,
} from "../support/probe-helpers";
import {
  closeAgenticChatSettings,
  openAgenticChatSettings,
  readSettingsBodyText,
  selectSettingsTab,
  waitForSetting,
} from "../../support/settings-ui";

/**
 * Card 1 (tool consolidation) user-visible changes in one recording:
 * the Agent tab has no "Tool budget" rows, `search_tools` loads a deferred
 * tool, and the always-loaded `current_time` runs.
 */
describe("probe: tool consolidation", function () {
  this.timeout(180_000);

  before(async function () {
    await installScriptedTurns([
      {
        label: "search",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "probe-search-tools",
            name: "search_tools",
            arguments: { query: "extract text from a PDF" },
          },
        ],
      },
      {
        label: "call",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "probe-current-time",
            name: "current_time",
            arguments: {},
          },
        ],
      },
      {
        label: "final",
        stopReason: "stop",
        content: [
          { type: "text", text: "Loaded import_document and read the clock." },
        ],
      },
    ]);
    await configurePlugin({
      provider: "openrouter",
      openrouterApiKey: "e2e-scripted-key",
      mode: "safe",
      web: { enabled: false },
    });
    await openChat();
  });

  after(async function () {
    try {
      await closeAgenticChatSettings();
    } catch {
      // Settings were already closed by the scenario.
    }
  });

  it("shows no tool budget rows, loads a deferred tool, and runs current_time", async function () {
    // Chat first: the layout checks run before the settings window opens.
    await mark("chat: ask for a PDF tool and the time");
    await sendPrompt("which tool imports a PDF, and what time is it?");
    await waitForScriptedCalls(3);
    await browser.waitUntil(
      async () =>
        (await $(".agentic-chat-messages").getText()).includes(
          "read the clock",
        ),
      { timeout: 10_000, timeoutMsg: "the final answer never rendered" },
    );
    const transcript = await $(".agentic-chat-messages").getText();
    expect(transcript).not.toMatch(/not found/i);
    expect(transcript).not.toContain("No deferred tools match");
    await mark("search_tools loaded import_document; current_time ran");

    await expectNoHorizontalOverflow(".agentic-chat-view");
    await expectWithinViewport(".agentic-chat-input");

    await openAgenticChatSettings();
    await selectSettingsTab("Agent");
    await waitForSetting("Auto-compaction");
    await mark("agent tab open: no Tool budget rows");
    const body = await readSettingsBodyText();
    expect(body).toContain("Compact at (% of context window)");
    expect(body).not.toContain("Tool budget");
    await browser.pause(2_000);
    await closeAgenticChatSettings();
    await browser.pause(500);
    await writeMetrics({
      mode: "scripted",
      toolBudgetRowsVisible: body.includes("Tool budget"),
      scriptedCalls: 3,
      notFoundInTranscript: /not found/i.test(transcript),
    });
    await browser.pause(1_500);
  });
});
