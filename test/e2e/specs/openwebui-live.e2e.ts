import { readFileSync } from "node:fs";
import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

/**
 * Live OpenAI-compatible e2e: gated on AGENTIC_CHAT_API_KEY because it spends
 * real tokens and depends on a reachable gateway. Validates the Obsidian
 * requestUrl transport path.
 */

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openrouter/auto";

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

async function sendPrompt(prompt: string): Promise<void> {
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(prompt);
  await $(".agentic-chat-send").click();
}

function readApiKey(): string | undefined {
  const inline = process.env.AGENTIC_CHAT_API_KEY?.trim();
  if (inline) return inline;

  const file = process.env.AGENTIC_CHAT_API_KEY_FILE?.trim();
  if (!file) return undefined;
  const fromFile = readFileSync(file, "utf8").trim();
  return fromFile || undefined;
}

async function configureProvider(config: { apiKey: string; baseUrl: string; model: string }): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, liveConfig) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) return false;
    const settings = plugin.settings as {
      provider: string;
      openaiCompatibleApiKey: string;
      openaiCompatibleBaseUrl: string;
      openaiCompatibleModel: string;
      requestTimeoutMs: number;
      maxNetworkRetries: number;
      mode: string;
      approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
    };
    settings.provider = "openai-compatible";
    settings.openaiCompatibleApiKey = liveConfig.apiKey;
    settings.openaiCompatibleBaseUrl = liveConfig.baseUrl;
    settings.openaiCompatibleModel = liveConfig.model;
    settings.requestTimeoutMs = 120_000;
    settings.maxNetworkRetries = 0;
    settings.mode = "safe";
    settings.approval.mutating = "ask";
    settings.approval.perTool = {};
    settings.approval.workingDirs = [];
    await plugin.saveSettings?.();
    return true;
  }, config);
}

async function renderedAssistantText(): Promise<string> {
  const elements = await browser.$$(".agentic-chat-assistant .agentic-chat-text");
  const text: string[] = [];
  for (const element of elements) text.push(await element.getText());
  return text.join("\n");
}

async function renderedErrorText(): Promise<string> {
  const elements = await browser.$$(".agentic-chat-error");
  const text: string[] = [];
  for (const element of elements) text.push(await element.getText());
  return text.join("\n").trim();
}

async function waitForAssistantText(pattern: RegExp, timeoutMsg: string): Promise<string> {
  await browser.waitUntil(
    async () => {
      const text = await renderedAssistantText();
      const error = await renderedErrorText();
      return pattern.test(text) || error.length > 0;
    },
    { timeout: 120_000, timeoutMsg },
  );

  const error = await renderedErrorText();
  if (error) throw new Error(error);
  return await renderedAssistantText();
}

describe("agentic-chat OpenAI-compatible live", function () {
  before(async function () {
    const apiKey = readApiKey();
    if (!apiKey) this.skip();

    const configured = await configureProvider({
      apiKey,
      baseUrl: process.env.AGENTIC_CHAT_BASE_URL?.trim() || DEFAULT_BASE_URL,
      model: process.env.AGENTIC_CHAT_MODEL?.trim() || DEFAULT_MODEL,
    });
    if (!configured) throw new Error("agentic-chat plugin not found in the test vault");
    await openChat();
  });

  it("answers a basic prompt through the OpenAI-compatible requestUrl transport", async function () {
    await sendPrompt("Reply exactly: pong");
    const text = await waitForAssistantText(/\bpong\b/i, "OpenWebUI reply did not render pong");
    await expect(text).toMatch(/\bpong\b/i);
  });

  it("runs a read-tool round trip through the same provider", async function () {
    await browser.executeObsidianCommand("agentic-chat:new-conversation");
    await sendPrompt(
      'Use the read tool to read "Welcome.md". After the tool result, reply exactly: tool-ok',
    );

    await $(".agentic-chat-step.is-done").waitForExist({ timeout: 120_000 });
    const text = await waitForAssistantText(/\btool-ok\b/i, "OpenWebUI tool flow did not render tool-ok");
    await expect(text).toMatch(/\btool-ok\b/i);
  });
});
