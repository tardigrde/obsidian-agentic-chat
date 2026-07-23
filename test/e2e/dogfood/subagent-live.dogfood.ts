import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

const TURN_TIMEOUT_MS = Number(process.env.DOGFOOD_TURN_TIMEOUT_MS || 120_000);

describe("agentic-chat subagent live dogfood", function () {
  const apiKey = process.env.AGENTIC_CHAT_API_KEY?.trim();
  const baseUrl = process.env.AGENTIC_CHAT_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
  const model = process.env.AGENTIC_CHAT_MODEL?.trim() || "openrouter/auto";

  before(async function () {
    if (process.env.AGENTIC_CHAT_SUBAGENT_DOGFOOD !== "true") this.skip();
    if (!apiKey) this.skip();

    const configured = await browser.executeObsidian(async ({ app }, liveConfig) => {
      const plugin = (app as unknown as {
        plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
      }).plugins?.plugins?.["agentic-chat"];
      if (!plugin?.settings) return false;
      const settings = plugin.settings as {
        provider: string;
        openaiCompatibleApiKey: string;
        openaiCompatibleBaseUrl: string;
        openaiCompatibleModel: string;
        mode: string;
        enableBuiltinAgents: boolean;
        approval: { mutating: string };
      };
      settings.provider = "openai-compatible";
      settings.openaiCompatibleApiKey = liveConfig.apiKey;
      settings.openaiCompatibleBaseUrl = liveConfig.baseUrl;
      settings.openaiCompatibleModel = liveConfig.model;
      settings.mode = "safe";
      settings.approval.mutating = "allow";
      settings.enableBuiltinAgents = true;
      await plugin.saveSettings?.();
      return true;
    }, { apiKey, baseUrl, model });

    if (!configured) throw new Error("agentic-chat plugin not found in the dogfood vault");
    await browser.executeObsidianCommand("agentic-chat:open-chat");
    await $(".agentic-chat-view").waitForExist();
  });

  it("dispatches a subagent and renders its live inline transcript", async function () {
    await browser.execute((value) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
      const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
      if (!textarea || !send) throw new Error("agentic-chat composer is not mounted");
      textarea.value = value;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    }, "Use the researcher subagent to list the files in the vault root and summarize what you see in one sentence.");

    const subagentBlock = await $(".agentic-chat-subagent");
    await subagentBlock.waitForExist({ timeout: 30_000 });
    await expect(subagentBlock.$(".agentic-chat-subagent-name")).toHaveText(/researcher:/i);

    await browser.waitUntil(
      async () => {
        const stopVisible = await $(".agentic-chat-stop").isDisplayed().catch(() => false);
        const approvalOpen = await $(".agentic-chat-approval").isExisting().catch(() => false);
        const askUserOpen = await $(".agentic-chat-ask-user").isExisting().catch(() => false);
        return !stopVisible && !approvalOpen && !askUserOpen;
      },
      { timeout: TURN_TIMEOUT_MS, timeoutMsg: "subagent live dogfood turn did not finish" },
    );

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
