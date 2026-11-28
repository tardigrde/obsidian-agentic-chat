import { describe, expect, it } from "vitest";
import type { App, SettingDefinitionGroup, SettingDefinitionPage } from "obsidian";
import { AgenticChatSettingTab } from "../src/settings";
import { secretInputDef } from "../src/settings-definition-kit";
import { perToolApprovalRows } from "../src/settings-tab-agent";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import { SETTINGS_TABS } from "../src/settings-tabs";
import { TOOL_CATALOG } from "../src/tools/tool-catalog";

function makeHarness(mutate?: (settings: typeof DEFAULT_SETTINGS) => void) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  mutate?.(settings);
  const calls = { saves: 0, invalidations: 0 };
  const plugin = {
    settings,
    settingsStore: {
      save: async () => {
        calls.saves += 1;
      },
      update: async (mutator: (current: typeof settings) => boolean | void) => {
        if (mutator(settings) === false) return false;
        calls.saves += 1;
        return true;
      },
    },
    saveSettings: async () => {
      calls.saves += 1;
    },
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

describe("secret inputs", () => {
  function renderSecret(hasValue: boolean): { placeholder: string; values: string[] } {
    let placeholder = "";
    const values: string[] = [];
    const text = {
      inputEl: { type: "" },
      setPlaceholder(value: string) {
        placeholder = value;
        return this;
      },
      setValue(value: string) {
        values.push(value);
        return this;
      },
      onChange() {
        return this;
      },
    };
    const setting = {
      setDesc() {
        return this;
      },
      addText(callback: (component: typeof text) => void) {
        callback(text);
        return this;
      },
      addButton() {
        return this;
      },
    };
    secretInputDef(
      {
        name: "API key",
        desc: "Stored with Obsidian secret storage.",
        placeholder: "paste key",
        hasValue: () => hasValue,
        onSet: async () => {},
        onForget: async () => {},
      },
      () => {},
    ).render?.(setting as never, {} as never);
    return { placeholder, values };
  }

  it("shows dots when a value is stored, and never puts the value in the field", () => {
    const stored = renderSecret(true);
    expect(stored.placeholder).toBe("••••••••");
    expect(stored.values).toEqual([""]);
  });

  it("keeps the normal placeholder when no value is stored", () => {
    expect(renderSecret(false).placeholder).toBe("paste key");
  });
});

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
      expect.arrayContaining(["Auto-compaction"]),
    );
    expect(names("approval")).toEqual(
      expect.arrayContaining(["Before mutating tools", "Per-tool overrides"]),
    );
    // One row for every tool in the one catalog, so no built-in tool is missing
    // an approval override.
    expect(names("approval")).toEqual(
      expect.arrayContaining(TOOL_CATALOG.map((entry) => entry.label)),
    );
    expect(names("mcp")).toEqual(
      expect.arrayContaining(["Enable MCP", "HTTP proxy", "No proxy", "Add MCP server"]),
    );
    expect(names("web")).toEqual(expect.arrayContaining(["Enable web search & fetch"]));
    expect(names("plugins")).toEqual(expect.arrayContaining(["Import", "Plugins folder"]));
    expect(names("ignored-files")).toEqual(expect.arrayContaining(["Ignored paths"]));
  });

  it("does not override the deprecated imperative display()", () => {
    expect(Object.prototype.hasOwnProperty.call(AgenticChatSettingTab.prototype, "display")).toBe(false);
  });

  it("keys every per-tool approval row by a real catalog tool and shows its real default", () => {
    const catalogNames = new Set(TOOL_CATALOG.map((entry) => entry.name));
    const rows = perToolApprovalRows(DEFAULT_SETTINGS);
    expect(rows.map((row) => row.toolName)).toEqual(TOOL_CATALOG.map((entry) => entry.name));
    for (const row of rows) {
      expect(catalogNames.has(row.toolName), row.toolName).toBe(true);
      const entry = TOOL_CATALOG.find((candidate) => candidate.name === row.toolName);
      expect(row.defaultLabel).toBe(`Default (${entry?.mutating ? DEFAULT_SETTINGS.approval.mutating : "allow"})`);
    }
    expect(rows.find((row) => row.toolName === "read")?.defaultLabel).toBe("Default (allow)");
    expect(rows.find((row) => row.toolName === "write")?.defaultLabel).toBe("Default (ask)");
    expect(rows.find((row) => row.toolName === "subagent")?.defaultLabel).toBe("Default (allow)");
  });

  it("says that a folder delete still asks when the Delete default is allow", () => {
    const label = (mutating: "allow" | "ask") =>
      perToolApprovalRows({ ...DEFAULT_SETTINGS, approval: { mutating, perTool: {} } }).find(
        (row) => row.toolName === "delete",
      )?.defaultLabel;

    expect(label("allow")).toBe("Default (allow, folders ask)");
    expect(label("ask")).toBe("Default (ask)");
  });

  it("rebuilds the rows when the global mutating policy changes, so the Default labels follow it", async () => {
    const { tab } = makeHarness();
    let updates = 0;
    (tab as unknown as { update: () => void }).update = () => {
      updates += 1;
    };

    await tab.setControlValue("approval.mutating", "allow");

    expect(updates).toBe(1);
  });

  it("reads and writes nested control keys through the plugin settings", async () => {
    const { tab, settings, calls } = makeHarness();
    expect(tab.getControlValue("notifications.costCapUsd")).toBe(DEFAULT_SETTINGS.notifications.costCapUsd);

    await tab.setControlValue("network.proxyUrl", "  http://192.0.2.10:3128/  ");
    await tab.setControlValue("privacy.denyDataCollection", false);
    await tab.setControlValue("notifications.costCapUsd", 9);

    expect(settings.network.proxyUrl).toBe("http://192.0.2.10:3128/");
    expect(settings.privacy.denyDataCollection).toBe(false);
    expect(settings.notifications.costCapUsd).toBe(9);
    expect(calls.saves).toBe(3);
  });

  it("rebuilds the MCP section when MCP is enabled", () => {
    const { tab } = makeHarness((next) => {
      next.mcp.enabled = true;
    });
    const mcp = pages(tab)
      .flatMap((page) => groups(page))
      .find((group) => group.id === "mcp");
    expect(mcp?.items?.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Enable MCP", "HTTP proxy", "No proxy", "Add MCP server", "MCP servers"]),
    );
    // U7 #6: a first-time user sees the add form first; the proxy rows come last.
    const order = mcp?.items?.map((item) => item.name) ?? [];
    expect(order.indexOf("Add MCP server")).toBeLessThan(order.indexOf("MCP servers"));
    expect(order.indexOf("MCP servers")).toBeLessThan(order.indexOf("HTTP proxy"));
    expect(order.indexOf("HTTP proxy")).toBeLessThan(order.indexOf("No proxy"));
  });
});
