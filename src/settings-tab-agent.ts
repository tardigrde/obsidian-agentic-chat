import type { SettingDefinitionItem } from "obsidian";
import { type ApprovalPolicy, setPerToolApproval } from "./agent/approval";
import { controlDef, headingRow, row } from "./settings-definition-kit";
import type { AgenticChatSettings } from "./settings-schema";
import { MUTATING_TOOLS } from "./tools/tool-contracts";
import { createVaultTools } from "./tools/vault-tools";
import type { SettingsTabHost } from "./settings-tab-host";

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
          "Override allow/ask/deny for individual tools. 'Default' follows the rule above (read-only tools always run).",
        )
        .setHeading();
    }),
  );
  for (const tool of createVaultTools(host.app)) {
    const mutating = MUTATING_TOOLS.has(tool.name);
    items.push(
      row(tool.label, (setting) => {
        setting.setDesc(`${tool.name} · ${mutating ? "mutating" : "read-only"}`).addDropdown((dropdown) => {
          dropdown
            .addOption("default", "Default")
            .addOption("allow", "Allow")
            .addOption("ask", "Ask")
            .addOption("deny", "Deny")
            .setValue(settings.approval.perTool[tool.name] ?? "default")
            .onChange(async (value) => {
              setPerToolApproval(settings.approval, tool.name, value as ApprovalPolicy | "default");
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
