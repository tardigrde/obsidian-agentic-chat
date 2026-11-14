import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { waitForComposerReady } from "../support/layout";
import {
  closeAgenticChatSettings,
  focusMainWindow,
  openAgenticChatSettings,
  readAgenticChatSettings,
  readSettingSelect,
  selectSettingsTab,
  setSettingSelect,
  waitForAgenticChatSetting,
  waitForSetting,
} from "../support/settings-ui";

/** Seed the note the chat view auto-attaches, so opening the chat has a file. */
async function seedWelcomeNote(): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }) => {
    const body = "# Welcome\n\nSettings mode sync fixture.";
    const existing = app.vault.getAbstractFileByPath("Welcome.md");
    const file = existing instanceof obsidian.TFile ? existing : await app.vault.create("Welcome.md", body);
    if (existing instanceof obsidian.TFile) await app.vault.modify(existing, body);
    await app.workspace.getLeaf(false).openFile(file);
  });
}

/** Persist a mode through the plugin's real save path before the UI renders. */
async function setStoredMode(mode: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, nextMode) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<string, { settings?: { mode?: string }; saveSettings?: () => Promise<void> }>;
      };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    plugin.settings.mode = nextMode;
    await plugin.saveSettings?.();
  }, mode);
}

async function readToggleState(): Promise<{ checked: string | null; label: string | null }> {
  return await browser.execute(() => {
    const toggle = document.querySelector<HTMLElement>(".agentic-chat-mode-toggle");
    if (!toggle) throw new Error("composer mode toggle not found");
    return { checked: toggle.getAttribute("aria-checked"), label: toggle.getAttribute("aria-label") };
  });
}

describe("agentic-chat settings mode sync", function () {
  before(async function () {
    await setStoredMode("safe");
    await seedWelcomeNote();
    await browser.executeObsidianCommand("agentic-chat:open-chat");
    await $(".agentic-chat-view").waitForExist();
    await waitForComposerReady();
    await openAgenticChatSettings();
    await selectSettingsTab("Agent");
    await waitForSetting("Permission mode");
  });

  after(async function () {
    await closeAgenticChatSettings();
  });

  it("follows the composer YOLO toggle in the settings dropdown", async function () {
    expect(await readSettingSelect("Permission mode")).toBe("safe");

    await focusMainWindow();
    await $(".agentic-chat-mode-toggle").click();

    await waitForAgenticChatSetting(
      (settings) => settings.mode === "yolo",
      "the composer toggle did not persist YOLO",
    );
    const stored = (await readAgenticChatSettings<{ mode: string }>()).mode;
    const dropdown = await readSettingSelect("Permission mode");
    expect(stored).toBe("yolo");
    expect(dropdown).toBe(stored);
  });

  it("reflects a settings dropdown change back in the composer toggle", async function () {
    await setSettingSelect("Permission mode", "safe");
    await waitForAgenticChatSetting(
      (settings) => settings.mode === "safe",
      "the settings dropdown did not persist Safe",
    );

    await focusMainWindow();
    const toggle = await readToggleState();
    expect(toggle.checked).toBe("false");
    expect(toggle.label).toBe("Permission mode: Safe");
  });
});
