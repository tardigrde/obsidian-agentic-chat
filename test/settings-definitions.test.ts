import { describe, expect, it } from "vitest";
import type { App, SettingDefinitionGroup, SettingDefinitionPage } from "obsidian";
import { AgenticChatSettingTab } from "../src/settings";
import { createMcpServerSettings } from "../src/mcp/settings";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import { SETTINGS_TABS } from "../src/settings-tabs";

function makeHarness(mutate?: (settings: typeof DEFAULT_SETTINGS) => void) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  mutate?.(settings);
  const calls = { saves: 0, invalidations: 0 };
  const plugin = {
    settings,
    saveSettings: async () => {
      calls.saves += 1;
    },
    requestModeChange: async () => true,
    pluginService: {
      hasCache: () => false,
      hasRetainedImportBackup: () => false,
      reload: async () => [],
      getLoaded: () => [],
      invalidate: () => {
        calls.invalidations += 1;
      },
      listExternallyDeletedPlugins: async () => [],
    },
  };
  return { tab: new AgenticChatSettingTab({} as App, plugin as never), settings, calls };
}

function makeTab(mutate?: (settings: typeof DEFAULT_SETTINGS) => void): AgenticChatSettingTab {
  return makeHarness(mutate).tab;
}

function pages(tab: AgenticChatSettingTab): Array<SettingDefinitionPage & { id?: string }> {
  return tab.getSettingDefinitions().filter((item): item is SettingDefinitionPage & { id?: string } => {
    return "type" in item && item.type === "page";
  });
}

function groups(page: SettingDefinitionPage): Array<SettingDefinitionGroup & { id?: string }> {
  return (page.items ?? []).filter((item): item is SettingDefinitionGroup & { id?: string } => {
    return "type" in item && (item.type === "group" || item.type === "list");
  });
}

describe("declarative settings definitions", () => {
  it("exposes exactly the three tabs from the pure tab map, in order", () => {
    const tab = makeTab();
    expect(pages(tab).map((page) => page.name)).toEqual(["Models", "Agent", "Advanced"]);
    expect(pages(tab).map((page) => page.id)).toEqual(SETTINGS_TABS.map((definition) => definition.id));
  });

  it("keeps every section from the pure map under its tab, exactly once", () => {
    const tab = makeTab();
    const actual = pages(tab).map((page) => ({
      id: page.id,
      sections: groups(page).map((group) => group.id),
    }));
    expect(actual).toEqual(
      SETTINGS_TABS.map((definition) => ({ id: definition.id, sections: [...definition.sections] })),
    );
  });

  it("puts the expected surrounding rows in each section group", () => {
    const tab = makeTab((settings) => {
      settings.mcp.enabled = true;
      settings.web.enabled = true;
    });
    const all = pages(tab).flatMap((page) => groups(page));
    const names = (id: string): string[] =>
      (all.find((group) => group.id === id)?.items ?? []).map((item) => item.name);

    expect(names("models")).toEqual(
      expect.arrayContaining(["Model provider", "HTTP proxy", "No proxy", "OpenRouter API key", "Model"]),
    );
    expect(names("agent")).toEqual(
      expect.arrayContaining(["Permission mode", "Temperature", "System prompt", "Auto-compaction"]),
    );
    expect(names("approval")).toEqual(
      expect.arrayContaining(["Before mutating tools", "Per-tool overrides"]),
    );
    expect(names("mcp")).toEqual(
      expect.arrayContaining(["Enable MCP", "HTTP proxy", "No proxy", "Add MCP server"]),
    );
    expect(names("web")).toEqual(expect.arrayContaining(["Enable web search & fetch"]));
    expect(names("plugins")).toEqual(expect.arrayContaining(["Import", "Plugins folder"]));
    expect(names("ignored-files")).toEqual(expect.arrayContaining(["Ignore list"]));
  });

  it("does not override the deprecated imperative display()", () => {
    expect(Object.prototype.hasOwnProperty.call(AgenticChatSettingTab.prototype, "display")).toBe(false);
  });

  it("reads and writes nested control keys through the plugin settings", async () => {
    const { tab, settings, calls } = makeHarness();
    expect(tab.getControlValue("web.maxResults")).toBe(DEFAULT_SETTINGS.web.maxResults);

    await tab.setControlValue("network.proxyUrl", "  http://192.0.2.10:3128/  ");
    await tab.setControlValue("privacy.denyDataCollection", false);
    await tab.setControlValue("web.maxResults", 9);

    expect(settings.network.proxyUrl).toBe("http://192.0.2.10:3128/");
    expect(settings.privacy.denyDataCollection).toBe(false);
    expect(settings.web.maxResults).toBe(9);
    expect(calls.saves).toBe(3);
  });

  it("rebuilds the MCP section when MCP is enabled and servers change", () => {
    const { tab } = makeHarness((next) => {
      next.mcp.enabled = true;
      next.mcp.servers = [
        createMcpServerSettings({
          id: "docs",
          name: "Docs MCP",
          url: "https://docs.example.com/mcp",
        }),
      ];
    });
    const mcp = pages(tab)
      .flatMap((page) => groups(page))
      .find((group) => group.id === "mcp");
    expect(mcp?.items?.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Enable MCP", "HTTP proxy", "No proxy", "Add MCP server", "MCP servers"]),
    );
  });
});
