import type { SettingDefinitionItem } from "obsidian";
import { type ApprovalPolicy, type ApprovalSettings, setPerToolApproval } from "./agent/approval";
import { controlDef, headingRow, row } from "./settings-definition-kit";
import type { AgenticChatSettings } from "./settings-schema";
import { TOOL_CATALOG } from "./tools/tool-catalog";
import type { SettingsTabHost } from "./settings-tab-host";

export interface PerToolApprovalRow {
  toolName: string;
  label: string;
  mutating: boolean;
  /** The label on the dropdown's `default` option: the policy an unset tool really follows. */
  defaultLabel: string;
}

/** Read-only tools run unless overridden; mutating tools follow the global policy. */
export function defaultApprovalOptionLabel(approval: ApprovalSettings, mutating: boolean): string {
  return `Default (${mutating ? approval.mutating : "allow"})`;
}

/** One approval row per catalog tool, keyed by the tool name the gate reads. */
export function perToolApprovalRows(settings: AgenticChatSettings): PerToolApprovalRow[] {
  return TOOL_CATALOG.map((tool) => ({
    toolName: tool.name,
    label: tool.label,
    mutating: tool.mutating,
    defaultLabel: defaultApprovalOptionLabel(settings.approval, tool.mutating),
  }));
}

export function agentDefinitions(_settings: AgenticChatSettings, _host: SettingsTabHost): SettingDefinitionItem[] {
  return [
    headingRow("Context window"),
    controlDef(
      "Auto-compaction",
      { type: "toggle", key: "compaction.enabled" },
      "Summarize older turns automatically as the context window fills, so long conversations don't hit the " +
        "model limit or spike cost.",
    ),
  ];
}

export function approvalDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
  const items: SettingDefinitionItem[] = [
    controlDef(
      "Before mutating tools",
      {
        type: "dropdown",
        key: "approval.mutating",
        options: { allow: "Allow automatically", ask: "Ask each time", deny: "Deny (read-only mode)" },
      },
      "Gate tools that change the vault. Read-only tools always run. 'Ask' shows a confirm dialog.",
    ),
  ];

  items.push(
    row("Per-tool overrides", (setting) => {
      setting
        .setDesc(
          "Override allow/ask/deny for individual tools ('Default' follows the rule above; read-only tools always run). " +
          "Dispatch is allow/deny only, and a recursive delete always asks unless deletes are explicitly allowed.",
        )
        .setHeading();
    }),
  );
  for (const tool of perToolApprovalRows(settings)) {
    items.push(
      row(tool.label, (setting) => {
        const detail =
          tool.toolName === "subagent"
            ? "dispatch never prompts; deny blocks it"
            : tool.toolName === "delete"
              ? "mutating; recursive delete always asks unless allowed"
              : tool.mutating
                ? "mutating"
                : "read-only";
        setting.setDesc(`${tool.toolName} · ${detail}`).addDropdown((dropdown) => {
          dropdown
            .addOption("default", defaultApprovalOptionLabel(settings.approval, tool.mutating))
            .addOption("allow", "Allow");
          // Dispatch has no approval gate (the child never prompts), so an Ask
          // option would silently behave like Allow. Only an explicit deny applies.
          if (tool.toolName !== "subagent") dropdown.addOption("ask", "Ask");
          dropdown
            .addOption("deny", "Deny")
            .setValue(settings.approval.perTool[tool.toolName] ?? "default")
            .onChange(async (value) => {
              setPerToolApproval(settings.approval, tool.toolName, value as ApprovalPolicy | "default");
              await host.save();
            });
        });
      }),
    );
  }
  return items;
}

export function notificationDefinitions(): SettingDefinitionItem[] {
  return [
    controlDef(
      "Background notifications",
      { type: "toggle", key: "notifications.enabled" },
      "Show toasts for background signals (agent finished while you're elsewhere, context window filling, cost cap). Errors always show.",
    ),
    controlDef(
      "Cost alert (USD)",
      { type: "number", key: "notifications.costAlertUsd", min: 0, step: "any" },
      "Notify once when a conversation's cost crosses this amount. 0 disables.",
    ),
    controlDef(
      "Hard spend cap (USD)",
      { type: "number", key: "notifications.costCapUsd", min: 0, step: "any" },
      "Block new turns — and stop a turn already running — once this conversation's cost reaches this amount. " +
        "0 (or an empty field) turns the cap off. Applies only to models with known pricing.",
    ),
  ];
}
