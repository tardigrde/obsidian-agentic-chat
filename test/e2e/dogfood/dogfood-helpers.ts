import { browser, $ } from "@wdio/globals";

export const TURN_TIMEOUT_MS = Number(process.env.DOGFOOD_TURN_TIMEOUT_MS || 120_000);

export async function sendPrompt(text: string): Promise<void> {
  await browser.execute((value) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
    const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
    if (!textarea || !send) throw new Error("agentic-chat composer is not mounted");
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    send.click();
  }, text);
}

export async function waitForTurnEnd(timeoutMs: number): Promise<void> {
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

export async function configureLivePlugin(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  enableBuiltinAgents?: boolean;
}): Promise<void> {
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
      enableBuiltinAgents?: boolean;
      approval: { mutating: string };
    };
    settings.provider = "openai-compatible";
    settings.openaiCompatibleApiKey = liveConfig.apiKey;
    settings.openaiCompatibleBaseUrl = liveConfig.baseUrl;
    settings.openaiCompatibleModel = liveConfig.model;
    settings.mode = "safe";
    settings.approval.mutating = "allow";
    if (liveConfig.enableBuiltinAgents != null) {
      settings.enableBuiltinAgents = liveConfig.enableBuiltinAgents;
    }
    await plugin.saveSettings?.();
    return true;
  }, options);

  if (!configured) throw new Error("agentic-chat plugin not found in the dogfood vault");
}

export async function readLatestSessionRaw(): Promise<string> {
  return await browser.executeObsidian(async ({ app }) => {
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
    if (!latest) return "";
    return await adapter.read(latest.path);
  });
}
