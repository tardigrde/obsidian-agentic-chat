import { describe, expect, it, vi } from "vitest";
import { FakeApp } from "./helpers/fake-vault";
import AgenticChatPlugin from "../src/main";
import { ChatView } from "../src/ui/chat-view";
import { PluginService } from "../src/plugins/service";
import type { App } from "obsidian";

vi.mock("../src/llm/pricing-cache", () => ({
  initPricingCache: () => undefined,
}));

/** A loaded plugin with one open chat view whose mode refresh is counted. */
async function loadedPlugin(): Promise<{ plugin: AgenticChatPlugin; refresh: ReturnType<typeof vi.fn> }> {
  const app = new FakeApp();
  const refresh = vi.fn();
  const view = Object.assign(Object.create(ChatView.prototype), { refreshModeFromSettings: refresh });
  const workspace = app.workspace as unknown as Record<string, unknown>;
  workspace.on = () => undefined;
  workspace.getLeavesOfType = () => [{ view }];
  (app.vault as unknown as { on: () => void }).on = () => undefined;
  (app as unknown as { secretStorage: unknown }).secretStorage = {
    getSecret: () => "",
    setSecret: () => undefined,
  };
  const PluginCtor = AgenticChatPlugin as unknown as new () => AgenticChatPlugin;
  const plugin = new PluginCtor();
  const target = plugin as unknown as Record<string, unknown>;
  target.app = app;
  target.manifest = { id: "agentic-chat", dir: ".obsidian/plugins/agentic-chat" };
  target.loadData = async () => null;
  target.saveData = async () => undefined;
  for (const method of ["registerView", "registerObsidianProtocolHandler", "addRibbonIcon", "addCommand", "addSettingTab", "registerEvent"]) {
    target[method] = () => undefined;
  }
  const service = new PluginService(app as unknown as App, () => plugin.settings, () => plugin.saveSettings());
  service.ensureBuiltinsMaterialized = async () => false;
  service.ensureMySkillsMaterialized = async () => false;
  target.pluginService = service;
  await plugin.onload();
  refresh.mockClear();
  return { plugin, refresh };
}

describe("mode broadcast to chat views", () => {
  it("refreshes open chat views once after a save that changed the mode", async () => {
    const { plugin, refresh } = await loadedPlugin();
    const next = plugin.settings.mode === "safe" ? "yolo" : "safe";

    await plugin.settingsStore.update((settings) => {
      settings.mode = next;
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh chat views on a save that left the mode unchanged", async () => {
    const { plugin, refresh } = await loadedPlugin();

    await plugin.saveSettings();
    await plugin.settingsStore.update((settings) => {
      settings.systemPrompt = `${settings.systemPrompt ?? ""} more`;
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh chat views when the save fails", async () => {
    const { plugin, refresh } = await loadedPlugin();
    (plugin as unknown as { saveData: () => Promise<void> }).saveData = async () => {
      throw new Error("disk full");
    };
    const next = plugin.settings.mode === "safe" ? "yolo" : "safe";

    await expect(
      plugin.settingsStore.update((settings) => {
        settings.mode = next;
      }),
    ).rejects.toThrow("disk full");

    expect(refresh).not.toHaveBeenCalled();
  });
});
