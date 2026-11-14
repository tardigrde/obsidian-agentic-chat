import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { AgenticChatSettingTab } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings-schema";

/** A plugin whose `settings` property records every reassignment. */
function pluginRecordingSettingsWrites() {
  const live = structuredClone(DEFAULT_SETTINGS);
  live.web.enabled = false;
  live.provider = "openrouter";
  const reassignments: unknown[] = [];
  const plugin = {
    get settings() {
      return live;
    },
    set settings(next: unknown) {
      reassignments.push(next);
    },
    settingsStore: {
      save: async () => undefined,
      update: async (mutator: (current: typeof live) => boolean | void) => {
        if (mutator(live) === false) return false;
        return true;
      },
    },
    saveSettings: async () => undefined,
    pluginService: {
      hasCache: () => false,
      hasRetainedImportBackup: () => false,
      reload: async () => [],
      getLoaded: () => [],
      invalidate: () => undefined,
      listExternallyDeletedPlugins: async () => [],
    },
  };
  return { plugin, live, reassignments };
}

describe("settings tab hidden controls", () => {
  it("validates a hidden row without swapping the plugin's live settings", async () => {
    const { plugin, live, reassignments } = pluginRecordingSettingsWrites();
    const tab = new AgenticChatSettingTab({} as App, plugin as never);

    // Web search is off and Ollama is not the provider, so both rows are hidden.
    await tab.setControlValue("web.searchProvider", "searxng");
    await tab.setControlValue("ollamaModel", "  qwen2.5  ");

    expect(reassignments).toEqual([]);
    expect(live.provider).toBe("openrouter");
    expect(live.web.enabled).toBe(false);
    expect(live.web.searchProvider).toBe("searxng");
    expect(live.ollamaModel).toBe("qwen2.5");
  });
});
