import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";
import {
  configureLivePlugin,
  sendPrompt,
  TURN_TIMEOUT_MS,
  waitForTurnEnd,
} from "./dogfood-helpers";

describe("agentic-chat subagent live dogfood", function () {
  const apiKey = process.env.AGENTIC_CHAT_API_KEY?.trim();
  const baseUrl = process.env.AGENTIC_CHAT_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
  const model = process.env.AGENTIC_CHAT_MODEL?.trim() || "openrouter/auto";

  before(async function () {
    if (process.env.AGENTIC_CHAT_SUBAGENT_DOGFOOD !== "true") this.skip();
    if (!apiKey) this.skip();

    await configureLivePlugin({ apiKey, baseUrl, model, enableBuiltinAgents: true });

    // Disable the tool budget: this spec validates live subagent dispatch, and the
    // budget (default 2% of the context window) silently drops optional tools such
    // as `subagent` once the full tool schema grows past the threshold.
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as unknown as {
        plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
      }).plugins?.plugins?.["agentic-chat"];
      if (!plugin?.settings) return;
      const settings = plugin.settings as { toolBudget: { enabled: boolean; thresholdPercent: number } };
      settings.toolBudget = { enabled: false, thresholdPercent: 2 };
      await plugin.saveSettings?.();
    });

    await browser.executeObsidianCommand("agentic-chat:open-chat");
    await $(".agentic-chat-view").waitForExist();
  });

  it("dispatches a subagent and renders its live inline transcript", async function () {
    await sendPrompt(
      "Use the researcher subagent to list the files in the vault root and summarize what you see in one sentence.",
    );

    const subagentBlock = await $(".agentic-chat-subagent");
    await subagentBlock.waitForExist({ timeout: 30_000 });
    await expect(subagentBlock.$(".agentic-chat-subagent-name")).toHaveText(/researcher:/i);

    await waitForTurnEnd(TURN_TIMEOUT_MS);

    const statusText = await subagentBlock.$(".agentic-chat-subagent-status").getText();
    expect(statusText).toMatch(/done|error/i);

    await browser.execute(() => {
      const details = document.querySelector<HTMLDetailsElement>(".agentic-chat-subagent");
      if (details) details.open = true;
    });

    const pre = await subagentBlock.$("pre");
    await expect(pre).toExist();
    expect((await pre.getText()).length).toBeGreaterThan(0);
  });
});
