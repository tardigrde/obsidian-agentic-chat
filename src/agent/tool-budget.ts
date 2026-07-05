import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface ToolBudgetSettings {
  /** Drop optional tools once model-visible tool schemas exceed this share of the context window. */
  enabled: boolean;
  /** Tool-schema percent of the context window (1-50) at which optional tools are withheld. */
  thresholdPercent: number;
}

export interface ToolBudgetState {
  droppedToolNames: Set<string>;
  triggeredAtToolSchemaFraction: number | null;
  toolSchemaTokens: number | null;
}

export interface ToolBudgetDroppedTool {
  name: string;
  reason: string;
}

export interface ToolBudgetSnapshot {
  enabled: boolean;
  active: boolean;
  thresholdPercent: number;
  triggeredAtToolSchemaPercent: number | null;
  toolSchemaTokens: number | null;
  contextWindow: number | null;
  droppedTools: ToolBudgetDroppedTool[];
}

export interface ApplyToolBudgetOptions {
  tools: readonly AgentTool[];
  settings: ToolBudgetSettings;
  state: ToolBudgetState;
  contextWindow?: number;
}

export const DEFAULT_TOOL_BUDGET_SETTINGS: ToolBudgetSettings = {
  enabled: true,
  thresholdPercent: 2,
};

const MIN_THRESHOLD_PERCENT = 1;
const MAX_THRESHOLD_PERCENT = 50;

const WEB_TOOL_NAMES = new Set(["web_search", "fetch_url"]);
const ARTIFACT_TOOL_NAMES = new Set(["list_artifacts", "read_artifact", "search_artifact", "export_artifact"]);

export function createToolBudgetState(): ToolBudgetState {
  return { droppedToolNames: new Set<string>(), triggeredAtToolSchemaFraction: null, toolSchemaTokens: null };
}

export function resetToolBudgetState(state: ToolBudgetState): void {
  state.droppedToolNames.clear();
  state.triggeredAtToolSchemaFraction = null;
  state.toolSchemaTokens = null;
}

export function healToolBudgetSettings(stored: Partial<ToolBudgetSettings> | null | undefined): ToolBudgetSettings {
  return {
    enabled: typeof stored?.enabled === "boolean" ? stored.enabled : DEFAULT_TOOL_BUDGET_SETTINGS.enabled,
    thresholdPercent: normalizeThresholdPercent(stored?.thresholdPercent),
  };
}

export function applyToolBudget(options: ApplyToolBudgetOptions): { tools: AgentTool[]; snapshot: ToolBudgetSnapshot } {
  const settings = healToolBudgetSettings(options.settings);
  if (!settings.enabled) {
    resetToolBudgetState(options.state);
    return { tools: [...options.tools], snapshot: snapshotFor(settings, options.state) };
  }

  const contextWindow = normalizeContextWindow(options.contextWindow);
  const thresholdFraction = settings.thresholdPercent / 100;
  const toolSchemaTokens = estimateToolDefinitionTokens(options.tools);
  const toolSchemaFraction = contextWindow === undefined ? undefined : toolSchemaTokens / contextWindow;
  const shouldDrop = toolSchemaFraction !== undefined && toolSchemaFraction >= thresholdFraction;

  options.state.droppedToolNames.clear();
  options.state.toolSchemaTokens = contextWindow === undefined ? null : toolSchemaTokens;
  options.state.triggeredAtToolSchemaFraction = shouldDrop ? toolSchemaFraction : null;
  if (shouldDrop) {
    for (const tool of options.tools) {
      if (toolBudgetDropReason(tool.name)) options.state.droppedToolNames.add(tool.name);
    }
  }

  return {
    tools: shouldDrop ? options.tools.filter((tool) => !options.state.droppedToolNames.has(tool.name)) : [...options.tools],
    snapshot: snapshotFor(settings, options.state, contextWindow),
  };
}

export function estimateToolDefinitionTokens(tools: readonly AgentTool[]): number {
  const modelVisible = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? {},
  }));
  return Math.ceil(JSON.stringify(modelVisible).length / 4);
}

export function toolBudgetDropReason(toolName: string): string | null {
  if (WEB_TOOL_NAMES.has(toolName)) return "web egress";
  if (toolName.startsWith("mcp__")) return "remote MCP";
  if (toolName === "subagent") return "subagent delegation";
  if (toolName === "import_pdf" || toolName === "import_document") return "document import";
  if (ARTIFACT_TOOL_NAMES.has(toolName)) return "artifact lookup";
  return null;
}

function snapshotFor(
  settings: ToolBudgetSettings,
  state: ToolBudgetState,
  contextWindow?: number,
): ToolBudgetSnapshot {
  return {
    enabled: settings.enabled,
    active: settings.enabled && state.triggeredAtToolSchemaFraction !== null,
    thresholdPercent: settings.thresholdPercent,
    triggeredAtToolSchemaPercent:
      state.triggeredAtToolSchemaFraction === null ? null : Math.round(state.triggeredAtToolSchemaFraction * 100),
    toolSchemaTokens: state.toolSchemaTokens,
    contextWindow: contextWindow ?? null,
    droppedTools: [...state.droppedToolNames].map((name) => ({
      name,
      reason: toolBudgetDropReason(name) ?? "optional",
    })),
  };
}

function normalizeThresholdPercent(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TOOL_BUDGET_SETTINGS.thresholdPercent;
  return Math.min(MAX_THRESHOLD_PERCENT, Math.max(MIN_THRESHOLD_PERCENT, Math.trunc(parsed)));
}

function normalizeContextWindow(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}
