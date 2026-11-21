import type { DropdownComponent, SettingDefinitionItem } from "obsidian";
import { type ApprovalPolicy, setPerToolApproval } from "./agent/approval";
import { type AgentMode, MODE_ORDER, MODES } from "./agent/modes";
import { DEFAULT_SYSTEM_PROMPT } from "./agent/system-prompt";
import { boundedNumberRow, controlDef, headingRow, row } from "./settings-definition-kit";
import { MAX_PARALLEL_SUBAGENTS, MAX_RESPONSE_TOKENS, MIN_PARALLEL_SUBAGENTS, type AgenticChatSettings } from "./settings-schema";
import { MUTATING_TOOLS } from "./tools/tool-contracts";
import { createVaultTools } from "./tools/vault-tools";
import { clampRowNumber, type SettingsTabHost } from "./settings-tab-host";

export function agentDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
  return [
    row("Permission mode", (setting) => {
      let dropdown: DropdownComponent | undefined;
      setting
        .setDesc(
          "Safe honors your approval gates; YOLO auto-approves every mutating tool for the session " +
            "(a per-tool deny still wins). The settings dropdown and the composer toggle share one setting and stay in sync.",
        )
        .addDropdown((component) => {
          dropdown = component;
          // S4: single list, same labels as MODES — every surface reflects the same source (Codex atomic override).
          for (const id of MODE_ORDER) component.addOption(id, MODES[id].label);
          component.setValue(settings.mode).onChange(async (value) => {
            const target = value as AgentMode;
            await host.plugin.requestModeChange(target);
            // Re-sync the dropdown to the actual persisted value (blocked transitions leave it unchanged; Notice is shown by requestModeChange).
            component.setValue(settings.mode);
          });
        });
      // The composer toggle can change the mode while this row is on screen
      // (settings may live in its own window); follow the persisted value.
      return host.plugin.onModeChange((mode) => dropdown?.setValue(mode));
    }),
    controlDef("Temperature", { type: "slider", key: "temperature", min: 0, max: 2, step: 0.1 }),
    boundedNumberRow({
      name: "Max response tokens",
      desc: `Per model request, 0 to ${MAX_RESPONSE_TOKENS.toLocaleString("en-US")}. 0 lets the provider decide.`,
      min: 0,
      max: MAX_RESPONSE_TOKENS,
      get: () => settings.maxTokens,
      set: async (value) => {
        settings.maxTokens = value;
        await host.save();
      },
    }),
    row("Request timeout (seconds)", (setting) => {
      setting
        .setDesc("How long to wait for the provider to start responding.")
        .addText((text) =>
          text.setValue(String(Math.round(settings.requestTimeoutMs / 1000))).onChange(async (value) => {
            const seconds = clampRowNumber(value, 5, Number.POSITIVE_INFINITY);
            if (seconds !== undefined) settings.requestTimeoutMs = seconds * 1000;
            await host.save();
          }),
        );
    }),
    controlDef(
      "Network retries",
      { type: "slider", key: "maxNetworkRetries", min: 0, max: 5, step: 1 },
      "Automatic retries on rate limits and transient server errors.",
    ),
    row("System prompt", (setting) => {
      setting
        .setDesc("Sent at the start of every conversation.")
        .addTextArea((text) => {
          text.inputEl.rows = 10;
          text.inputEl.addClass("agentic-chat-system-prompt");
          text.setValue(settings.systemPrompt).onChange(async (value) => {
            settings.systemPrompt = value.trim() ? value : DEFAULT_SYSTEM_PROMPT;
            await host.save();
          });
        });
    }),
    {
      name: "Standing instructions",
      desc:
        "The agent loads AGENTS.md from the vault root every turn as standing context " +
        "(falls back to CLAUDE.md, then GEMINI.md, if AGENTS.md is absent — symlink them for other agents). " +
        "Edit the file directly, or run /init to have the agent curate it.",
    },
    headingRow("Context window"),
    controlDef(
      "Auto-compaction",
      { type: "toggle", key: "compaction.enabled" },
      "Summarize older turns automatically as the context window fills, so long conversations don't hit the " +
        "model limit or spike cost. The summary replaces the compacted turns in the transcript.",
    ),
    controlDef(
      "Compact at (% of context window)",
      { type: "slider", key: "compaction.thresholdPercent", min: 50, max: 95, step: 5 },
      "Trigger compaction once the conversation fills this share of the model's context window.",
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

export function subagentDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
  return [
    boundedNumberRow({
      name: "Parallel subagents",
      desc:
        `How many subagents run at once in one turn (${MIN_PARALLEL_SUBAGENTS}-${MAX_PARALLEL_SUBAGENTS}); the rest queue. ` +
        "Stop and the spend cap stop them all.",
      min: MIN_PARALLEL_SUBAGENTS,
      max: MAX_PARALLEL_SUBAGENTS,
      get: () => settings.maxParallelSubagents,
      set: async (value) => {
        settings.maxParallelSubagents = value;
        await host.save();
      },
    }),
  ];
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
