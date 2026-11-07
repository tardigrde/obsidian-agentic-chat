/**
 * Top-level settings tabs and the sections each one renders.
 *
 * The cut in #247 keeps every setting but reduces the visible navigation to
 * three tabs. Advanced groups the opt-in integrations and resource controls so
 * the default view stays focused on setup.
 */
export const SETTINGS_SECTION_IDS = [
  "models",
  "agent",
  "approval",
  "web",
  "mcp",
  "observability",
  "notifications",
  "plugins",
  "subagents",
  "retrieval",
  "ignored-files",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export type SettingsTabId = "models" | "agent" | "advanced";

export interface SettingsTabDefinition {
  id: SettingsTabId;
  label: string;
  sections: readonly SettingsSectionId[];
}

/**
 * The visible tab order. Add a section to an existing tab instead of adding a
 * fourth tab: the product cut keeps the default navigation at three entries.
 */
export const SETTINGS_TABS: readonly SettingsTabDefinition[] = [
  { id: "models", label: "Models", sections: ["models"] },
  { id: "agent", label: "Agent", sections: ["agent", "approval"] },
  {
    id: "advanced",
    label: "Advanced",
    sections: [
      "web",
      "mcp",
      "observability",
      "notifications",
      "plugins",
      "subagents",
      "retrieval",
      "ignored-files",
    ],
  },
];
