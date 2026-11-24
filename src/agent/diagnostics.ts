import type {
  AgentEvent,
  AgentTool,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { activeModelId, type AgenticChatSettings } from "../settings-schema";
import type { SessionInfo } from "../session/session-manager";
import type { AgentRuntimeResources } from "./runtime-resources";
import type { McpServerDiagnostic } from "../mcp/tools";
import type { ObservabilityExportHealth } from "../observability/agent-observability";

export const MAX_RECENT_DIAGNOSTIC_EVENTS = 30;

export interface AgentRuntimeDiagnostics {
  session: {
    id: string | null;
    path: string | null;
    name: string | null;
    messageCount: number;
  };
  provider: string;
  model: string;
  modelOverride: string | null;
  contextWindow: number | null;
  thinkingLevel: ThinkingLevel;
  mode: string;
  approval: {
    mutating: string;
    perToolOverrides: number;
  };
  tools: string[];
  resources: {
    skillCount: number;
    profileCount: number;
    hasInstructionsOverlay: boolean;
    lastReloadAt: string | null;
    mcpServers: McpServerDiagnostic[];
  };
  observability: {
    enabled: boolean;
    backend: string;
    endpointConfigured: boolean;
    payloadMode: string;
    sampleRate: number;
    exportHealth: ObservabilityExportHealth;
  };
  state: {
    isStreaming: boolean;
    canUndo: boolean;
    lastError: string | null;
    contextPercent: number | null;
    compactionCount: number;
    totalTokens: number;
  };
  recentEvents: string[];
}

export interface BuildRuntimeDiagnosticsOptions {
  settings: AgenticChatSettings;
  sessionInfo: SessionInfo | undefined;
  sessionPath: string | null;
  tools: readonly AgentTool[];
  resources: AgentRuntimeResources;
  resourcesReloadedAt: string | null;
  modelOverride: string | null;
  contextWindow: number | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  canUndo: boolean;
  lastError: string | undefined;
  contextFraction: number | undefined;
  compactionCount: number;
  usage: Usage;
  recentEvents: readonly string[];
  observabilityHealth: ObservabilityExportHealth;
}

export function buildRuntimeDiagnostics(options: BuildRuntimeDiagnosticsOptions): AgentRuntimeDiagnostics {
  const { settings, sessionInfo } = options;
  return {
    session: {
      id: sessionInfo?.id ?? null,
      path: options.sessionPath,
      name: sessionInfo?.name ?? null,
      messageCount: sessionInfo?.messageCount ?? 0,
    },
    provider: settings.provider,
    model: options.modelOverride ?? activeModelId(settings),
    modelOverride: options.modelOverride,
    /** Resolved context window for the active model (null when unknown). */
    contextWindow: options.contextWindow,
    thinkingLevel: options.thinkingLevel,
    mode: settings.mode,
    approval: {
      mutating: settings.approval.mutating,
      perToolOverrides: Object.keys(settings.approval.perTool).length,
    },
    tools: options.tools.map((tool) => tool.name),
    resources: {
      skillCount: options.resources.skills.length,
      profileCount: options.resources.profiles.length,
      hasInstructionsOverlay: options.resources.instructionsOverlay.trim().length > 0,
      lastReloadAt: options.resourcesReloadedAt,
      mcpServers: options.resources.mcpDiagnostics,
    },
    observability: {
      enabled: settings.observability.enabled,
      backend: settings.observability.backend,
      endpointConfigured: settings.observability.endpoint.trim().length > 0,
      payloadMode: settings.observability.payloadMode,
      sampleRate: settings.observability.sampleRate,
      exportHealth: options.observabilityHealth,
    },
    state: {
      isStreaming: options.isStreaming,
      canUndo: options.canUndo,
      lastError: options.lastError ?? null,
      contextPercent: options.contextFraction === undefined ? null : Math.round(options.contextFraction * 100),
      compactionCount: options.compactionCount,
      totalTokens: options.usage.totalTokens,
    },
    recentEvents: [...options.recentEvents],
  };
}

export function summarizeAgentEvent(event: AgentEvent): string {
  switch (event.type) {
    case "agent_start":
      return "agent_start";
    case "agent_end":
      return `agent_end:${event.messages.length} messages`;
    case "turn_start":
      return "turn_start";
    case "turn_end":
      return `turn_end:${event.message.role},${event.toolResults.length} tool results`;
    case "message_start":
      return `message_start:${event.message.role}`;
    case "message_update":
      return `message_update:${event.message.role}:${event.assistantMessageEvent.type}`;
    case "message_end":
      return `message_end:${event.message.role}`;
    case "tool_execution_start":
      return `tool_execution_start:${event.toolName}#${event.toolCallId}`;
    case "tool_execution_update":
      return `tool_execution_update:${event.toolName}#${event.toolCallId}`;
    case "tool_execution_end":
      return `tool_execution_end:${event.toolName}#${event.toolCallId}:${event.isError ? "error" : "ok"}`;
    default:
      return exhaustiveEvent(event);
  }
}

export function formatMcpDiagnosticRows(servers: readonly McpServerDiagnostic[]): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const server of servers) {
    const extra: Array<[string, string]> =
      server.status === "ok" ? [[`MCP tools: ${server.serverName}`, formatList(server.toolNames)]] : [];
    rows.push(
      [`MCP server: ${server.serverName}`, formatMcpServerDiagnostic(server)],
      [`MCP URL: ${server.serverName}`, server.url],
      [`MCP auth: ${server.serverName}`, formatMcpAuthDiagnostic(server)],
      ...extra,
    );
  }
  return rows;
}

export function formatMcpDiagnosticSummary(servers: readonly McpServerDiagnostic[]): string {
  if (servers.length === 0) return "(none)";
  return servers
    .map((server) => `${server.serverName}=${formatMcpServerDiagnostic(server)}`)
    .join("; ");
}

function formatMcpServerDiagnostic(server: McpServerDiagnostic): string {
  if (server.status === "ok") return `ok (${server.toolCount} tools)`;
  if (server.status === "disabled") return "disabled";
  const category = server.errorCategory ? `${server.errorCategory}: ` : "";
  return `error: ${category}${server.error ?? "unknown error"}`;
}

function formatMcpAuthDiagnostic(server: McpServerDiagnostic): string {
  const prefix = `type=${server.authType}, approval=${server.approval}, checked=${server.checkedAt}`;
  if (server.authType !== "oauth") return prefix;
  const oauth = server.oauth;
  if (!oauth) return `${prefix}, token=unknown`;
  return (
    `${prefix}, ` +
    `access=${oauth.hasAccessToken ? "yes" : "no"}, ` +
    `refresh=${oauth.hasRefreshToken ? "yes" : "no"}, ` +
    `expires=${oauth.expiresAt ?? "unknown"}, ` +
    `scope=${oauth.scope || "(none)"}, ` +
    `issuer=${oauth.authorizationServer || "(unknown)"}`
  );
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.join(", ");
}

function exhaustiveEvent(_event: never): string {
  return "unknown:event";
}
