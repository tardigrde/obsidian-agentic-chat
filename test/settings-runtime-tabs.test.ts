import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { AgenticChatSettingTab } from "../src/settings";

interface TabDefinition {
  id: string;
  label: string;
  sections: string[];
}

function tabDefinitions(): TabDefinition[] {
  const tab = new AgenticChatSettingTab({} as App, {} as never);
  return (tab as unknown as { tabs: TabDefinition[] }).tabs;
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
