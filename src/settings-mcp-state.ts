import { hasMcpOAuthAccess } from "./mcp/oauth";
import {
  mcpServerAuthProblem,
  mcpServerEndpointProblem,
  type McpKnownToolSettings,
  type McpServerSettings,
} from "./mcp/settings";
import { localMcpToolName } from "./mcp/tools";

export interface McpTestButtonState {
  label: string;
  busyLabel: string;
  problem: string;
  needsOAuthSignIn: boolean;
}

/** The loaded-package facts the Remove decision needs. */
export interface McpPackageFacts {
  mcpServers: readonly unknown[];
  skills: readonly unknown[];
  skillReports: readonly unknown[];
  reports: readonly unknown[];
  manifestProblem: string | null;
  mcpValidation: { servers: readonly unknown[] } | null;
}

/**
 * True when removing the package removes only this one server: one valid server,
 * no valid skill, and nothing skipped (a skill that failed to parse or an
 * unsupported server entry is still the user's file). Folder removal is permanent.
 */
export function isSoleServerPackage(plugin: McpPackageFacts | undefined): boolean {
  if (!plugin) return false;
  return (
    plugin.mcpServers.length === 1 &&
    (plugin.mcpValidation?.servers.length ?? 0) === 1 &&
    plugin.skills.length === 0 &&
    plugin.skillReports.length === 0 &&
    plugin.reports.length === 0 &&
    !plugin.manifestProblem
  );
}

export function formatMcpToolApprovalDescription(localName: string, tool: McpKnownToolSettings): string {
  return `${localName}${tool.readOnlyHint ? " · read-only hint" : ""}`;
}

export function formatMcpServerSummary(server: McpServerSettings, endpointProblem: string): string {
  const status = server.enabled ? "enabled" : "disabled";
  const auth = formatMcpAuthType(server);
  const toolLabel = server.knownTools.length === 1 ? "tool" : "tools";
  const tools =
    server.knownTools.length > 0
      ? `${server.knownTools.length} discovered ${toolLabel}`
      : "no tools discovered yet";
  const endpoint = endpointProblem || server.url || "No endpoint configured";
  return `${endpoint} · ${status} · ${auth} · ${tools}`;
}

export function formatMcpAuthType(server: McpServerSettings): string {
  if (server.authType === "none") return "no auth";
  if (server.authType === "bearer") return server.authHeaderValue ? "bearer token set" : "bearer token missing";
  if (server.authType === "header") {
    return server.authHeaderName && server.authHeaderValue ? `header ${server.authHeaderName}` : "static header incomplete";
  }
  return hasMcpOAuthAccess(server) ? "OAuth authenticated" : "OAuth not authenticated";
}

export function mcpEndpointProblem(url: string): string {
  return mcpServerEndpointProblem(url);
}

export function mcpAuthProblem(server: McpServerSettings): string {
  return mcpServerAuthProblem(server);
}

export function mcpTestButtonState(server: McpServerSettings): McpTestButtonState {
  const hasPendingOAuth = Boolean(server.pendingOAuthChallenge && server.pendingOAuthResourceUrl);
  const needsOAuthSignIn = (server.authType === "oauth" && !hasMcpOAuthAccess(server)) || hasPendingOAuth;
  const problem = mcpEndpointProblem(server.url) || (needsOAuthSignIn ? "" : mcpAuthProblem(server));
  return {
    label: needsOAuthSignIn ? "Authenticate & test" : "Test connection",
    busyLabel: needsOAuthSignIn ? "Authenticating..." : "Testing...",
    problem,
    needsOAuthSignIn,
  };
}

export function formatMcpToolSample(toolNames: string[]): string {
  const sample = toolNames.slice(0, 5).join(", ");
  return sample ? ` (${sample})` : "";
}

export function mcpSecretIds(server: McpServerSettings): string[] {
  return [
    server.authHeaderValueSecretId,
    server.oauth.clientSecretSecretId,
    server.oauth.accessTokenSecretId,
    server.oauth.refreshTokenSecretId,
  ].filter(Boolean);
}

export function mcpKnownToolLocalName(server: McpServerSettings, tool: McpKnownToolSettings): string {
  return tool.localName || localMcpToolName(server.id, tool.name);
}

export function mcpCredentialResourceChanged(previousUrl: string, nextUrl: string): boolean {
  const previous = mcpCredentialResourceState(previousUrl);
  const next = mcpCredentialResourceState(nextUrl);
  if (previous.kind === "placeholder" && next.kind === "resource") return false;
  if (previous.kind === "resource" && next.kind === "resource") return previous.value !== next.value;
  return previous.kind !== next.kind;
}

export function mcpCredentialResourceState(value: string): { kind: "placeholder" | "invalid" | "resource"; value?: string } {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "https://") return { kind: "placeholder" };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return { kind: "invalid" };
    parsed.hash = "";
    parsed.search = "";
    if (parsed.pathname === "/") parsed.pathname = "";
    return { kind: "resource", value: parsed.toString().replace(/\/$/, "") };
  } catch {
    return { kind: "invalid" };
  }
}
