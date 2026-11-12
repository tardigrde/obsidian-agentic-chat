import { browser, expect, $ } from "@wdio/globals";
import { after, before, describe, it } from "mocha";

type ScriptedTurn = {
  label?: string;
  content: Array<Record<string, unknown>>;
  stopReason?: "stop" | "length" | "toolUse";
};

function textTurn(label: string, text: string): ScriptedTurn {
  return { label, stopReason: "stop", content: [{ type: "text", text }] };
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
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "e2e-scripted-key";
    settings.mode = "safe";
    settings.approval.mutating = "allow";
    settings.approval.perTool = {};
    await plugin.saveSettings?.();
    return true;
  });
}

async function sendPrompt(text: string): Promise<void> {
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(text);
  await $(".agentic-chat-send").click();
}

async function transcriptText(): Promise<string> {
  return await $(".agentic-chat-messages").getText();
}

async function latestInfoText(): Promise<string> {
  await $(".agentic-chat-info").waitForExist();
  return await browser.execute(() => {
    const infos = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-info"));
    return infos.at(-1)?.innerText ?? "";
  });
}

describe("agentic-chat plan mode removal", function () {
  before(async function () {
    await installScriptedTurns([
      textTurn("plan-shaped prompt", "Plain chat answer without plan mode."),
    ]);
    const configured = await configurePlugin();
    if (!configured) throw new Error("agentic-chat plugin not found in the test vault");
    await openChat();
  });

  after(async function () {
    await browser.execute(() => {
      const target = window as typeof window & { __AGENTIC_CHAT_E2E_RELEASE__?: boolean };
      target.__AGENTIC_CHAT_E2E_RELEASE__ = true;
    });
  });

  it("keeps `/plan` out of help and the composer", async function () {
    await sendPrompt("/help");
    const info = await latestInfoText();
    expect(info).toMatch(/Slash commands/);
    expect(info).not.toMatch(/\/plan\b/);
    expect(info).not.toMatch(/plan mode/i);

    await expect($(".agentic-chat-plan-badge")).not.toExist();
    await expect($(".agentic-chat-mode-toggle")).toBeDisplayed();
  });

  it("treats `/plan` as a normal chat prompt and still answers", async function () {
    await sendPrompt("/plan outline the vault cleanup");
    await browser.waitUntil(
      async () => (await transcriptText()).includes("Plain chat answer without plan mode."),
      { timeout: 10_000, timeoutMsg: "the scripted normal chat answer never rendered" },
    );

    const transcript = await transcriptText();
    expect(transcript).toContain("/plan outline the vault cleanup");
    await expect($(".agentic-chat-plan-badge")).not.toExist();

    const mode = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as unknown as { plugins?: { plugins?: Record<string, { settings?: { mode?: string } }> } })
        .plugins?.plugins?.["agentic-chat"];
      return plugin?.settings?.mode ?? "";
    });
    expect(mode).toBe("safe");
    const toggle = $(".agentic-chat-mode-toggle");
    expect(await toggle.getAttribute("aria-label")).toBe(
      `Permission mode: ${mode === "yolo" ? "YOLO" : "Safe"}`,
    );
    expect(await toggle.getAttribute("aria-checked")).toBe(String(mode === "yolo"));
  });
});
