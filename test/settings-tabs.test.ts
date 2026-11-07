import { describe, expect, it } from "vitest";
import { SETTINGS_SECTION_IDS, SETTINGS_TABS } from "../src/settings-tabs";

describe("settings tab groups", () => {
  it("shows exactly three visible tabs in order", () => {
    expect(SETTINGS_TABS.map((tab) => tab.label)).toEqual(["Models", "Agent", "Advanced"]);
  });

  it("keeps the three core groups in the non-advanced tabs", () => {
    expect(SETTINGS_TABS.find((tab) => tab.id === "models")?.sections).toEqual(["models"]);
    expect(SETTINGS_TABS.find((tab) => tab.id === "agent")?.sections).toEqual(["agent", "approval"]);
  });

  it("groups MCP, web, observability, plugins, subagents, retrieval, and notifications under Advanced", () => {
    const advanced = SETTINGS_TABS.find((tab) => tab.id === "advanced");
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

  it("maps every render section exactly once so no setting is dropped", () => {
    const mapped = SETTINGS_TABS.flatMap((tab) => tab.sections);
    expect(mapped).toHaveLength(new Set(mapped).size);
    expect(new Set(mapped)).toEqual(new Set(SETTINGS_SECTION_IDS));
  });
});
