import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { openAgenticChatSettings, selectSettingsTab, waitForSetting } from "../support/settings-ui";

const VIEW_TYPE_AGENT_CHAT = "agentic-chat-chat-view";
const MOBILE_WIDTH = Number(process.env.AGENTIC_CHAT_E2E_VIEWPORT_WIDTH || 390);
const MOBILE_HEIGHT = Number(process.env.AGENTIC_CHAT_E2E_VIEWPORT_HEIGHT || 844);
const MOBILE_WRITE_PATH = "Mobile/E2E-Mobile-Approval.md";
const MOBILE_WRITE_BODY = "mobile approval write ok";

type ScriptedTurn = {
  label?: string;
  content: Array<Record<string, unknown>>;
  stopReason?: "stop" | "length" | "toolUse";
};

function toolTurn(label: string, id: string, name: string, args: Record<string, unknown>): ScriptedTurn {
  return {
    label,
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name, arguments: args }],
  };
}

function textTurn(label: string, text: string): ScriptedTurn {
  return {
    label,
    stopReason: "stop",
    content: [{ type: "text", text }],
  };
}

async function setMobileViewport(): Promise<void> {
  const cdpBrowser = browser as typeof browser & {
    cdp?: (domain: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  if (cdpBrowser.cdp) {
    await cdpBrowser.cdp("Emulation", "setDeviceMetricsOverride", {
      width: MOBILE_WIDTH,
      height: MOBILE_HEIGHT,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdpBrowser.cdp("Emulation", "setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
  await browser.waitUntil(
    async () => {
      const width = await browser.execute(() => window.innerWidth);
      return width <= MOBILE_WIDTH + 80;
    },
    {
      timeout: 5_000,
      timeoutMsg: `Browser did not enter a phone-sized viewport (wanted ${MOBILE_WIDTH}px, got ${await browser.execute(() => window.innerWidth)}px)`,
    },
  );
}

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

async function runSlashCommand(command: string): Promise<void> {
  await sendPrompt(command);
}

async function closeOpenModals(): Promise<void> {
  await browser.execute(() => {
    for (const close of Array.from(document.querySelectorAll<HTMLElement>(".modal-close-button"))) close.click();
    for (const backdrop of Array.from(document.querySelectorAll<HTMLElement>(".modal-bg"))) backdrop.click();
  });
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

async function seedMobileState(): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, writePath) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }>;
      };
      secretStorage?: { setSecret?: (id: string, value: string) => void };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");

    const settings = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      openrouterModel: string;
      mode: string;
      approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
      web: { enabled: boolean };
      mcp: { enabled: boolean; proxyUrl: string; noProxy: string; servers: unknown[] };
      network: { proxyUrl: string; noProxy: string };
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "e2e-mobile-scripted-key";
    settings.openrouterModel = "openai/gpt-4o-mini";
    settings.mode = "safe";
    settings.approval = { mutating: "ask", perTool: {}, workingDirs: [] };
    settings.web.enabled = false;
    settings.mcp = { enabled: false, proxyUrl: "", noProxy: "localhost,127.0.0.1,::1", servers: [] };
    settings.network = { proxyUrl: "", noProxy: "localhost,127.0.0.1,::1" };
    app.secretStorage?.setSecret?.("agentic-chat-openrouter-api-key", "e2e-mobile-scripted-key");
    await plugin.saveSettings?.();

    const existingMobileFolder = app.vault.getAbstractFileByPath("Mobile");
    if (!existingMobileFolder) await app.vault.createFolder("Mobile");
    const existingWrite = app.vault.getAbstractFileByPath(writePath);
    if (existingWrite instanceof obsidian.TFile) await app.vault.trash(existingWrite, true);

    const adapter = app.vault.adapter as unknown as {
      list: (path: string) => Promise<{ files: string[]; folders: string[] }>;
      mkdir: (path: string) => Promise<void>;
      remove: (path: string) => Promise<void>;
      write: (path: string, data: string) => Promise<void>;
    };
    const sessionsDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
    try {
      const listing = await adapter.list(sessionsDir);
      await Promise.all(listing.files.filter((file) => file.endsWith(".jsonl")).map((file) => adapter.remove(file)));
    } catch {
      await adapter.mkdir(sessionsDir);
    }

    const cwd = `obsidian-vault:${app.vault.getName()}`;
    const session = (id: string, name: string, prompt: string, answer: string, timestamp: string) =>
      `${[
        { type: "session", version: 1, id, timestamp, cwd },
        { type: "message", id: `${id}-user`, parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 } },
        { type: "message", id: `${id}-assistant`, parentId: `${id}-user`, timestamp, message: { role: "assistant", content: [{ type: "text", text: answer }], provider: "openrouter", model: "openai/gpt-4o-mini", timestamp: 1 } },
        { type: "session_info", id: `${id}-info`, parentId: `${id}-assistant`, timestamp, name },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`;

    await adapter.write(
      `${sessionsDir}/2026-06-25T00-00-00-000Z_mobile-alpha.jsonl`,
      session("mobile-alpha", "Mobile Alpha", "alpha prompt", "alpha answer", "2026-06-25T00:00:00.000Z"),
    );
    await adapter.write(
      `${sessionsDir}/2026-06-25T00-01-00-000Z_mobile-beta.jsonl`,
      session("mobile-beta", "Mobile Beta", "beta prompt", "beta answer", "2026-06-25T00:01:00.000Z"),
    );
  }, MOBILE_WRITE_PATH);
}

async function assertFits(rootSelector: string, label: string): Promise<void> {
  const result = await browser.execute((selector) => {
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) return { missing: selector, offenders: [] as string[], root: null };
    const rootRect = root.getBoundingClientRect();
    const offenders: string[] = [];
    const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden") continue;
      if (rect.left < rootRect.left - 2 || rect.right > rootRect.right + 2) {
        offenders.push(`${element.className || element.tagName} ${Math.round(rect.width)}w scroll=${element.scrollWidth}/${element.clientWidth}`);
      }
    }
    return {
      missing: "",
      offenders: offenders.slice(0, 8),
      root: {
        width: Math.round(rootRect.width),
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
      },
    };
  }, rootSelector);

  if (result.missing) throw new Error(`${label} root ${result.missing} was not found`);
  if (result.root && result.root.scrollWidth > result.root.clientWidth + 2) {
    throw new Error(`${label} root overflows horizontally: ${JSON.stringify(result.root)}`);
  }
  if (result.offenders.length > 0) throw new Error(`${label} has horizontal overflow: ${result.offenders.join("; ")}`);
}

async function allowApproval(): Promise<void> {
  const modal = await $(".agentic-chat-approval");
  await modal.waitForExist({ timeout: 10_000 });
  await expect(modal.$("button=Allow")).toBeDisplayed();
  await expect(modal.$("button=Deny")).toBeDisplayed();
  await assertFits(".modal-container .modal", "approval modal");
  await modal.$("button=Allow").click();
  await modal.waitForExist({ reverse: true, timeout: 5_000 });
}

async function noteExists(path: string): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, notePath) => app.vault.getAbstractFileByPath(notePath) != null, path);
}

describe("agentic-chat mobile viewport", function () {
  before(async function () {
    await setMobileViewport();
    await seedMobileState();
    await installScriptedTurns([
      toolTurn("mobile approval write", "mobile-write", "write", {
        path: MOBILE_WRITE_PATH,
        content: MOBILE_WRITE_BODY,
      }),
      textTurn("mobile approval final", "Wrote the mobile approval note."),
      textTurn(
        "mobile long response",
        `MobileWrap ${Array.from({ length: 30 }, (_, index) => `long-mobile-response-token-${index + 1}`).join("-")}`,
      ),
    ]);
    await openChat();
  });

  after(async function () {
    await closeOpenModals();
  });

  it("keeps the chat composer and toolbar usable at phone width", async function () {
    await expect($(".agentic-chat-input")).toBeDisplayed();
    await expect($(".agentic-chat-send")).toBeDisplayed();
    await expect($(".agentic-chat-mode-toggle")).toBeDisplayed();
    await assertFits(".agentic-chat-view", "chat view");
    await assertFits(".agentic-chat-field", "composer field");
  });

  it("keeps the settings tab UI usable at phone width", async function () {
    await openAgenticChatSettings();
    await selectSettingsTab("Models");
    await waitForSetting("Model provider");
    await selectSettingsTab("MCP");
    await waitForSetting("Enable MCP");
    await selectSettingsTab("Resources");
    await waitForSetting("Skills folder");
    await assertFits(".agentic-chat-settings-tabs", "settings tabs");
    await assertFits(".agentic-chat-settings-tabbody", "settings body");
    await closeOpenModals();
    await openChat();
  });

  it("keeps approval modals visible and touchable at phone width", async function () {
    await sendPrompt("mobile approval write");
    await allowApproval();
    await browser.waitUntil(async () => await noteExists(MOBILE_WRITE_PATH), {
      timeout: 10_000,
      timeoutMsg: "mobile approval write did not create the note",
    });
  });

  it("keeps the session history modal usable at phone width", async function () {
    await runSlashCommand("/sessions");
    await $(".agentic-chat-session-list").waitForExist();
    await expect($(".agentic-chat-session-row")).toBeDisplayed();
    await assertFits(".modal-container .modal", "session modal");
    await assertFits(".agentic-chat-session-list", "session list");
    await closeOpenModals();
  });

  it("wraps long assistant output without horizontal overflow", async function () {
    await sendPrompt("mobile long response");
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const texts = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-assistant .agentic-chat-text"));
          return texts.some((text) => text.innerText.includes("MobileWrap"));
        }),
      { timeout: 10_000, timeoutMsg: "mobile long response did not render" },
    );
    await assertFits(".agentic-chat-messages", "message list");
    await browser.executeObsidian(async ({ app }, viewType) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        service?: { abort?: () => void };
      };
      view?.service?.abort?.();
    }, VIEW_TYPE_AGENT_CHAT);
  });
});
