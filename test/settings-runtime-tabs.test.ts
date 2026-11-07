import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { AgenticChatSettingTab } from "../src/settings";
import type { SettingsTabDefinition } from "../src/settings-tabs";

function tabDefinitions(): readonly SettingsTabDefinition[] {
  const tab = new AgenticChatSettingTab({} as App, {} as never);
  return tab.tabs;
}

describe("settings runtime tabs", () => {
  it("exposes exactly three visible tab definitions", () => {
    expect(tabDefinitions().map((tab) => tab.label)).toEqual(["Models", "Agent", "Advanced"]);
  });

  it("keeps the moved groups under Advanced", () => {
    const advanced = tabDefinitions().find((tab) => tab.id === "advanced");
    expect(advanced?.sections).toEqual([
      "web",
      "mcp",
      "observability",
      "notifications",
      "plugins",
      "subagents",
      "retrieval",
      "ignored-files",
    ]);
  });
});
