import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

const TURN_TIMEOUT_MS = Number(process.env.DOGFOOD_TURN_TIMEOUT_MS || 120_000);

describe("agentic-chat B9+B11 live dogfood", function () {
  const apiKey = process.env.AGENTIC_CHAT_API_KEY?.trim();
  const baseUrl = process.env.AGENTIC_CHAT_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
  const model = process.env.AGENTIC_CHAT_MODEL?.trim() || "openrouter/auto";

  before(async function () {
    if (process.env.AGENTIC_CHAT_B9B11_DOGFOOD !== "true") this.skip();
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
        approval: { mutating: string };
      };
      settings.provider = "openai-compatible";
      settings.openaiCompatibleApiKey = liveConfig.apiKey;
      settings.openaiCompatibleBaseUrl = liveConfig.baseUrl;
      settings.openaiCompatibleModel = liveConfig.model;
      settings.mode = "safe";
      settings.approval.mutating = "allow";
      await plugin.saveSettings?.();
      return true;
    }, { apiKey, baseUrl, model });

    if (!configured) throw new Error("agentic-chat plugin not found in the dogfood vault");

    await browser.executeObsidian(async ({ app }) => {
      const notePath = "B9-B11 Dogfood.md";
      const file = app.vault.getAbstractFileByPath(notePath);
      if (file) await app.vault.delete(file);
      await app.vault.create(
        notePath,
        [
          "# B9-B11 Dogfood Test Note",
          "This note is used to verify read caching and context compression.",
          "Line 3: Apple Banana Cherry",
          "Line 4: Delta Echo Foxtrot",
          "Line 5: Golf Hotel India",
          "Line 6: Juliet Kilo Lima",
          "Line 7: Mike November Oscar",
          "Line 8: Papa Quebec Romeo",
          "Line 9: Sierra Tango Uniform",
          "Line 10: Victor Whiskey X-ray",
          "Line 11: Yankee Zulu Alpha",
          "Line 12: Bravo Charlie Delta",
        ].join("\n"),
      );
    });

    await browser.executeObsidianCommand("agentic-chat:open-chat");
    await $(".agentic-chat-view").waitForExist();
  });

  it("caches re-reads and compresses unchanged context across turns", async function () {
    await sendPrompt("Read the note B9-B11 Dogfood.md and tell me the first three words on line 3.");
    await waitForTurnEnd(TURN_TIMEOUT_MS);

    await sendPrompt("What is the last word on line 10?");
    await waitForTurnEnd(TURN_TIMEOUT_MS);

    await sendPrompt("Read B9-B11 Dogfood.md again and tell me the first word on line 12.");
    await waitForTurnEnd(TURN_TIMEOUT_MS);

    const inspection = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as unknown as {
        plugins?: { plugins?: Record<string, { manifest?: { dir?: string } }> };
      }).plugins?.plugins?.["agentic-chat"];
      const pluginDir = plugin?.manifest?.dir ?? `${app.vault.configDir}/plugins/agentic-chat`;
      const sessionsDir = `${pluginDir}/sessions`;
      const adapter = app.vault.adapter;
      const sessions = (await adapter.exists(sessionsDir))
        ? await Promise.all(
            (await adapter.list(sessionsDir)).files
              .filter((file) => file.endsWith(".jsonl"))
              .map(async (file) => ({ path: file, stat: await adapter.stat(file) })),
          )
        : [];
      sessions.sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0));
      const latest = sessions[0];
      if (!latest) return { error: "no session" };
      const raw = await adapter.read(latest.path);
      const lines = raw.trim().split("\n");
      const entries = lines.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      });

      const userMessages = entries
        .filter((e): e is NonNullable<typeof e> => e != null && e.type === "message" && e.message?.role === "user")
        .map((e) => e.message.content?.[0]?.text ?? "");

      const toolResults = entries
        .filter((e): e is NonNullable<typeof e> => e != null && e.type === "message" && e.message?.role === "toolResult")
        .map((e) => ({
          toolName: e.message.toolName,
          content: e.message.content?.[0]?.text ?? "",
          details: e.message.details,
        }));

      return { userMessages, toolResults, sessionPath: latest.path };
    });

    expect(inspection.error).toBeUndefined();

    const hasCompressedContext = inspection.userMessages.some((text: string) =>
      text.includes("context unchanged since previous turn"),
    );
    expect(hasCompressedContext, "B11: context should be compressed on a repeat turn").toBe(true);

    const hasCachedRead = inspection.toolResults.some(
      (tr: { toolName: string; details?: Record<string, unknown> }) =>
        tr.toolName === "read" && tr.details?.cached === true,
    );
    expect(hasCachedRead, "B9: re-read should be served from cache").toBe(true);
  });
});

async function sendPrompt(text: string): Promise<void> {
  await browser.execute((value) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
    const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
    if (!textarea || !send) throw new Error("agentic-chat composer is not mounted");
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    send.click();
  }, text);
}

async function waitForTurnEnd(timeoutMs: number): Promise<void> {
  await browser.waitUntil(
    async () => {
      const stopVisible = await $(".agentic-chat-stop").isDisplayed().catch(() => false);
      const approvalOpen = await $(".agentic-chat-approval").isExisting().catch(() => false);
      const askUserOpen = await $(".agentic-chat-ask-user").isExisting().catch(() => false);
      return !stopVisible && !approvalOpen && !askUserOpen;
    },
    { timeout: timeoutMs, timeoutMsg: "turn did not finish" },
  );
}
