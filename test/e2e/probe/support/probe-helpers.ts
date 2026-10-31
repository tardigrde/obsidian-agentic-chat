import { $, browser } from "@wdio/globals";
import { focusMainWindow, focusSettingsWindow } from "../../support/settings-ui";

export type ProbeSettings = {
  provider?: string;
  openrouterApiKey?: string;
  openaiCompatibleApiKey?: string;
  openaiCompatibleBaseUrl?: string;
  openaiCompatibleModel?: string;
  requestTimeoutMs?: number;
  maxNetworkRetries?: number;
  mode?: string;
  approval?: { mutating?: string; perTool?: Record<string, string>; workingDirs?: string[] };
  web?: { enabled?: boolean };
};

export type ScriptedTurn = {
  label?: string;
  content: Array<Record<string, unknown>>;
  stopReason?: "stop" | "length" | "toolUse";
  delayMs?: number;
};

export async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

export async function sendPrompt(prompt: string): Promise<void> {
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(prompt);
  await $(".agentic-chat-send").click();
}

export async function configurePlugin(patch: ProbeSettings): Promise<void> {
  const configured = await browser.executeObsidian(async ({ app }, next) => {
    const plugin = (
      app as unknown as {
        plugins?: {
          plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }>;
        };
      }
    ).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) return false;

    const settings = plugin.settings as Record<string, unknown> & {
      approval?: Record<string, unknown>;
      web?: Record<string, unknown>;
    };

    for (const [key, value] of Object.entries(next)) {
      if ((key === "approval" || key === "web") && value && typeof value === "object") {
        settings[key] = { ...(settings[key] ?? {}), ...(value as Record<string, unknown>) };
      } else {
        settings[key] = value;
      }
    }

    await plugin.saveSettings?.();
    return true;
  }, patch);

  if (!configured) throw new Error("agentic-chat plugin not found in the test vault");
}

export async function installScriptedTurns(turns: ScriptedTurn[]): Promise<void> {
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

export async function scriptedCallCount(): Promise<number> {
  return await browser.execute(() => {
    const target = window as typeof window & { __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[] };
    return target.__AGENTIC_CHAT_E2E_CALL_LOG__?.length ?? 0;
  });
}

export async function waitForScriptedCalls(count: number, timeout = 15_000): Promise<void> {
  await browser.waitUntil(async () => (await scriptedCallCount()) >= count, {
    timeout,
    timeoutMsg: `expected at least ${count} scripted turns, got ${await scriptedCallCount()}`,
  });
}

export async function readApprovalPerTool(tool: string): Promise<string | undefined> {
  await focusMainWindow();
  try {
    return await browser.executeObsidian(async ({ app }, name) => {
      const plugin = (
        app as unknown as {
          plugins?: { plugins?: Record<string, { settings?: Record<string, unknown> }> };
        }
      ).plugins?.plugins?.["agentic-chat"];
      const settings = plugin?.settings as { approval?: { perTool?: Record<string, string> } } | undefined;
      return settings?.approval?.perTool?.[name];
    }, tool);
  } finally {
    await focusSettingsWindow();
  }
}

export async function noteExists(path: string): Promise<boolean> {
  return await browser.executeObsidian(
    async ({ app }, notePath) => app.vault.getAbstractFileByPath(notePath) != null,
    path,
  );
}

export async function readNote(path: string): Promise<string> {
  return await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
    const file = app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof obsidian.TFile)) return "";
    return await app.vault.read(file);
  }, path);
}

export async function trashNotes(paths: string[]): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, notePaths) => {
    for (const path of notePaths) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof obsidian.TFile || file instanceof obsidian.TFolder) await app.vault.trash(file, true);
    }
  }, paths);
}

export async function renderedAssistantText(): Promise<string> {
  const elements = await browser.$$(".agentic-chat-assistant .agentic-chat-text");
  const parts: string[] = [];
  for (const element of elements) parts.push(await element.getText());
  return parts.join("\n");
}

export async function waitForNewAssistantText(previous: string, timeout = 120_000): Promise<string> {
  let latest = previous;
  await browser.waitUntil(
    async () => {
      const streaming = await browser.execute(
        () => document.querySelectorAll(".agentic-chat-text.is-streaming").length > 0,
      );
      if (streaming) return false;

      const next = await renderedAssistantText();
      if (next.length <= previous.length) return false;
      const stable = next === latest;
      latest = next;
      return stable && next.trim().length > previous.trim().length;
    },
    { timeout, interval: 1_000, timeoutMsg: "assistant produced no new stable text" },
  );
  return latest;
}
