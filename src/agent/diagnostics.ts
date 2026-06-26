import type {
  AgentEvent,
  AgentTool,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { activeModelId, type AgenticChatSettings } from "../settings";
import type { SessionInfo } from "../session/session-manager";
import type { AgentRuntimeResources } from "./runtime-resources";
import type { McpServerDiagnostic } from "../mcp/tools";

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
  thinkingLevel: ThinkingLevel;
  thinkingOverride: ThinkingLevel | null;
  mode: string;
  outputStyle: string;
  approval: {
    mutating: string;
    perToolOverrides: number;
    workingDirs: string[];
  };
  tools: string[];
  resources: {
    skillCount: number;
    profileCount: number;
    hasInstructionsOverlay: boolean;
    lastReloadAt: string | null;
    mcpServers: McpServerDiagnostic[];
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
  thinkingLevel: ThinkingLevel;
  thinkingOverride: ThinkingLevel | null;
  isStreaming: boolean;
  canUndo: boolean;
  lastError: string | undefined;
  contextFraction: number | undefined;
  compactionCount: number;
  usage: Usage;
  recentEvents: readonly string[];
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
    thinkingLevel: options.thinkingLevel,
    thinkingOverride: options.thinkingOverride,
    mode: settings.mode,
    outputStyle: settings.outputStyle,
    approval: {
      mutating: settings.approval.mutating,
      perToolOverrides: Object.keys(settings.approval.perTool).length,
      workingDirs: [...settings.approval.workingDirs],
    },
    tools: options.tools.map((tool) => tool.name),
    resources: {
      skillCount: options.resources.skills.length,
      profileCount: options.resources.profiles.length,
      hasInstructionsOverlay: options.resources.instructionsOverlay.trim().length > 0,
      lastReloadAt: options.resourcesReloadedAt,
      mcpServers: options.resources.mcpDiagnostics,
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

export function formatRuntimeDiagnosticsRows(diagnostics: AgentRuntimeDiagnostics): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Session path", diagnostics.session.path ?? "(none)"],
    ["Session", formatSession(diagnostics)],
    ["Provider", diagnostics.provider],
    ["Model", diagnostics.modelOverride ? `${diagnostics.model} (next message only)` : diagnostics.model],
    [
      "Thinking",
      diagnostics.thinkingOverride
        ? `${diagnostics.thinkingOverride} (next message only)`
        : diagnostics.thinkingLevel,
    ],
    ["Mode", diagnostics.mode],
    ["Output style", diagnostics.outputStyle],
    ["Tools", formatList(diagnostics.tools)],
    ["Approval", formatApproval(diagnostics)],
    ["Pending undo", diagnostics.state.canUndo ? "yes" : "no"],
    ["Resources", formatResources(diagnostics)],
    ["MCP", formatMcpDiagnosticSummary(diagnostics.resources.mcpServers)],
    ...formatMcpDiagnosticRows(diagnostics.resources.mcpServers),
    ["Streaming", diagnostics.state.isStreaming ? "yes" : "no"],
    ["Context", diagnostics.state.contextPercent === null ? "unknown" : `${diagnostics.state.contextPercent}%`],
    ["Usage", `${diagnostics.state.totalTokens} tokens, ${diagnostics.state.compactionCount} compactions`],
    ["Last error", diagnostics.state.lastError ?? "(none)"],
  ];
  if (diagnostics.recentEvents.length === 0) {
    rows.push(["Recent events", "(none)"]);
  } else {
    const start = Math.max(0, diagnostics.recentEvents.length - 8);
    rows.push(["Recent events", `${diagnostics.recentEvents.length} kept, showing latest ${diagnostics.recentEvents.length - start}`]);
    diagnostics.recentEvents.slice(start).forEach((event, index) => {
      rows.push([`Event ${start + index + 1}`, event]);
    });
  }
  return rows;
}

export function formatMcpDiagnosticRows(servers: readonly McpServerDiagnostic[]): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const server of servers) {
    rows.push([`MCP server: ${server.serverName}`, formatMcpServerDiagnostic(server)]);
    rows.push([`MCP URL: ${server.serverName}`, server.url]);
    rows.push([`MCP auth: ${server.serverName}`, formatMcpAuthDiagnostic(server)]);
    if (server.status === "ok") {
      rows.push([`MCP tools: ${server.serverName}`, formatList(server.toolNames)]);
    }
  }
  return rows;
}

function formatSession(diagnostics: AgentRuntimeDiagnostics): string {
  const { id, name, messageCount } = diagnostics.session;
  if (!id) return "(none)";
  return `${name ?? id} (${messageCount} messages)`;
}

function formatApproval(diagnostics: AgentRuntimeDiagnostics): string {
  const dirs = diagnostics.approval.workingDirs.length === 0
    ? "none"
    : diagnostics.approval.workingDirs.join(", ");
  return (
    `mutating=${diagnostics.approval.mutating}, ` +
    `per-tool overrides=${diagnostics.approval.perToolOverrides}, ` +
    `working dirs=${dirs}`
  );
}

function formatResources(diagnostics: AgentRuntimeDiagnostics): string {
  return (
    `skills=${diagnostics.resources.skillCount}, ` +
    `subagents=${diagnostics.resources.profileCount}, ` +
    `instructions=${diagnostics.resources.hasInstructionsOverlay ? "yes" : "no"}, ` +
    `reloaded=${diagnostics.resources.lastReloadAt ?? "never"}`
  );
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

function exhaustiveEvent(event: never): string {
  void event;
  return "unknown:event";
}
