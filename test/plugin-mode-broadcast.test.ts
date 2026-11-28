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
async function loadedPlugin(
  stored: Record<string, unknown> | null = null,
): Promise<{
  plugin: AgenticChatPlugin;
  refresh: ReturnType<typeof vi.fn>;
  saved: Record<string, unknown>[];
  streaming: { value: boolean };
}> {
  const app = new FakeApp();
  const refresh = vi.fn();
  const streaming = { value: false };
  const view = Object.assign(Object.create(ChatView.prototype), {
    refreshModeFromSettings: refresh,
    isStreaming: () => streaming.value,
  });
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
  target.loadData = async () => stored;
  const saved: Record<string, unknown>[] = [];
  target.saveData = async (data: Record<string, unknown>) => {
    saved.push(structuredClone(data));
  };
  for (const method of ["registerView", "registerObsidianProtocolHandler", "addRibbonIcon", "addCommand", "addSettingTab", "registerEvent"]) {
    target[method] = () => undefined;
  }
  const service = new PluginService(app as unknown as App, () => plugin.settings, () => plugin.saveSettings());
  service.ensureMySkillsMaterialized = async () => false;
  target.pluginService = service;
  await plugin.onload();
  refresh.mockClear();
  return { plugin, refresh, saved, streaming };
}

describe("newer settings format", () => {
  it("keeps a newer data.json untouched and refuses to save defaults over it", async () => {
    const { plugin, saved } = await loadedPlugin({ settingsVersion: 2, openrouterModel: "future/model" });

    expect(plugin.settings.openrouterModel).toBe("deepseek/deepseek-v4.1-flash");
    expect(saved).toEqual([]);
    await expect(plugin.saveSettings()).rejects.toThrow(/newer version/i);
  });
});

describe("runtime mode", () => {
  it("starts in Safe even when an old data.json stored a mode", async () => {
    const { plugin, saved } = await loadedPlugin({ mode: "yolo" });

    expect(plugin.mode).toBe("safe");
    expect(saved.length).toBeGreaterThan(0);
    expect("mode" in saved[0]).toBe(false);
  });

  it("refreshes every open chat view and notifies listeners once on a mode change", async () => {
    const { plugin, refresh } = await loadedPlugin();
    const listener = vi.fn();
    plugin.onModeChange(listener);

    expect(plugin.setMode("yolo")).toBe(true);

    expect(plugin.mode).toBe("yolo");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("yolo");
  });

  it("does not refresh or notify when the mode already matches", async () => {
    const { plugin, refresh } = await loadedPlugin();
    const listener = vi.fn();
    plugin.onModeChange(listener);

    expect(plugin.setMode("safe")).toBe(false);

    expect(refresh).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("refuses a mode change while any view is streaming", async () => {
    const { plugin, refresh, streaming } = await loadedPlugin();
    streaming.value = true;

    expect(plugin.setMode("yolo")).toBe(false);

    expect(plugin.mode).toBe("safe");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops notifying a listener after it unsubscribes", async () => {
    const { plugin } = await loadedPlugin();
    const listener = vi.fn();
    const unsubscribe = plugin.onModeChange(listener);
    unsubscribe();

    plugin.setMode("yolo");

    expect(listener).not.toHaveBeenCalled();
  });
});
