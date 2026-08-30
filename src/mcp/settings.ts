import type { ApprovalPolicy } from "../agent/approval";
import { DEFAULT_PROXY_SETTINGS, type ProxySettings, normalizeNoProxy, normalizeProxyUrl } from "../network/proxy";
import { ensureMcpOAuthSecretRefs, mcpSecretId } from "../secrets/secret-store";
import { isValidHttpHeaderName } from "./http-headers";
import { mcpUrlProblem } from "../utils/host-policy";
import { healMcpToolGlobs } from "./tool-filter";

export type McpAuthType = "none" | "bearer" | "header" | "oauth";
type LegacyMcpServerPreset = "generic" | "context7" | "oauth";

export interface McpSettings extends ProxySettings {
  /**
   * Master egress gate for remote MCP servers. Off by default; when off no MCP
   * tools are registered and no MCP endpoint is contacted.
   */
  enabled: boolean;
  /** Remote Streamable HTTP MCP servers. */
  servers: McpServerSettings[];
}

export interface McpServerSettings {
  /** Stable local id used in exposed tool names: mcp__<id>__<tool>. */
  id: string;
  /** User-facing server name. */
  name: string;
  /** Streamable HTTP endpoint, e.g. https://mcp.example.com/mcp. */
  url: string;
  enabled: boolean;
  /** Authentication mechanism for this remote MCP server. */
  authType: McpAuthType;
  /** Optional auth header name for custom static-header authentication. */
  authHeaderName: string;
  /** Optional bearer token or custom auth header value. */
  authHeaderValueSecretId: string;
  /** Deprecated plaintext migration/fallback field. Persisted as empty after save. */
  authHeaderValue: string;
  /** OAuth state and tokens for remote MCP servers that use MCP authorization. */
  oauth: McpOAuthSettings;
  /** Gate every tool call from this server; remote annotations are not trusted. */
  approval: ApprovalPolicy;
  /** Last discovered tools, cached only to render per-tool approval controls. */
  knownTools: McpKnownToolSettings[];
  /**
   * Literal headers from a plugin's mcp.json. Client-generated headers
   * (MCP protocol, auth) take precedence per the Agent Plugins spec.
   */
  headers: Record<string, string>;
  /** Where this server configuration came from. */
  source: "user" | "plugin";
  /** Vault path of the plugin package that declared this server, when plugin-sourced. */
  pluginRoot?: string;
  /**
   * Ordered allow-then-deny globs for remote tools (S5).
   * `enabledTools` is an allowlist: when non-empty only matching tools are exposed.
   * `disabledTools` is a denylist: any match is hidden even if allowed. Deny wins.
   * Same glob dialect as vault ignore (`*`/`**`/`?`, case-insensitive) so the three
   * ignore/deny mechanisms share one engine (file-system sandbox, writable roots, MCP).
   */
  enabledTools: string[];
  /** Deny globs for remote tools — deny wins over allow. */
  disabledTools: string[];
}

/** Client-owned state for a plugin-derived MCP server (shape lives in mcp.json). */
export interface McpServerState {
  enabled: boolean;
  approval: ApprovalPolicy;
  authType: McpAuthType;
  authHeaderName: string;
  authHeaderValueSecretId: string;
  /** Deprecated plaintext migration/fallback field. Persisted as empty after save. */
  authHeaderValue: string;
  oauth: McpOAuthSettings;
  knownTools: McpKnownToolSettings[];
  /** Last known URL for change detection — cleared auth if mcp.json moves host. */
  lastUrl?: string;
  /** Ordered allow-then-deny globs for remote tools (S5) — client-owned, like approval/auth. */
  enabledTools: string[];
  /** Deny globs for remote tools — deny wins. */
  disabledTools: string[];
}

export interface McpKnownToolSettings {
  /** Remote MCP tool name as returned by tools/list. */
  name: string;
  /** Exact local tool name registered for this remote tool, including collision suffixes. */
  localName?: string;
  title: string;
  /** Informational only. The user still chooses the approval policy. */
  readOnlyHint: boolean;
}

export interface McpServerExportConfig {
  kind: "agentic-chat.mcp-server";
  version: 1;
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  authType: McpAuthType;
  authHeaderName: string;
  approval: ApprovalPolicy;
  knownTools: Array<Pick<McpKnownToolSettings, "name" | "title" | "readOnlyHint">>;
  oauth?: {
    clientId: string;
    dynamicClientRegistration: boolean;
    registeredRedirectUri: string;
    authorizationServer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint: string;
    resourceMetadataUrl: string;
    scope: string;
  };
}

export type McpSetupStepStatus = "complete" | "action" | "blocked";

export interface McpSetupStep {
  id: "endpoint" | "auth" | "discovery";
  label: string;
  status: McpSetupStepStatus;
  message: string;
}

export interface McpOAuthSettings {
  clientId: string;
  clientSecretSecretId: string;
  /** Deprecated plaintext migration/fallback field. Persisted as empty after save. */
  clientSecret: string;
  /** True when clientId was obtained through dynamic client registration. */
  dynamicClientRegistration: boolean;
  /** Redirect URI used for the current dynamic client registration. */
  registeredRedirectUri: string;
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  resourceMetadataUrl: string;
  accessTokenSecretId: string;
  /** Deprecated plaintext migration/fallback field. Persisted as empty after save. */
  accessToken: string;
  refreshTokenSecretId: string;
  /** Deprecated plaintext migration/fallback field. Persisted as empty after save. */
  refreshToken: string;
  /** Unix epoch milliseconds. 0 means unknown/non-expiring. */
  expiresAt: number;
  scope: string;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  ...DEFAULT_PROXY_SETTINGS,
  servers: [],
};

export const DEFAULT_MCP_OAUTH_SETTINGS: McpOAuthSettings = {
  clientId: "",
  clientSecretSecretId: "",
  clientSecret: "",
  dynamicClientRegistration: false,
  registeredRedirectUri: "",
  authorizationServer: "",
  authorizationEndpoint: "",
  tokenEndpoint: "",
  registrationEndpoint: "",
  resourceMetadataUrl: "",
  accessTokenSecretId: "",
  accessToken: "",
  refreshTokenSecretId: "",
  refreshToken: "",
  expiresAt: 0,
  scope: "",
};

export function healMcpSettings(stored: Partial<McpSettings> | null | undefined): McpSettings {
  const servers = Array.isArray(stored?.servers) ? stored.servers.map(healMcpServer).filter(isMcpServer) : [];
  return {
    enabled: stored?.enabled === true,
    proxyUrl: normalizeProxyUrl(stored?.proxyUrl),
    noProxy: normalizeNoProxy(stored?.noProxy),
    servers: uniquifyMcpServerIds(servers),
  };
}

function isMcpServer(server: McpServerSettings | null): server is McpServerSettings {
  return server !== null;
}

function healMcpServer(server: Partial<McpServerSettings> | null | undefined): McpServerSettings | null {
  if (!server) return null;
  const url = normalizeLegacyMcpServerUrl(server);
  const legacyPreset = legacyMcpServerPreset((server as { preset?: unknown }).preset);
  const id = normalizeMcpServerId(server.id || server.name || serverIdFromMcpUrl(url) || "mcp");
  if (!url) return null;
  return {
    id,
    name: typeof server.name === "string" && server.name.trim() ? server.name.trim() : id,
    url,
    enabled: server.enabled !== false,
    authType: healAuthType(server.authType, legacyPreset, server.authHeaderName),
    authHeaderName: typeof server.authHeaderName === "string" ? server.authHeaderName.trim() : "",
    authHeaderValueSecretId: stringValue(server.authHeaderValueSecretId) || mcpSecretId(id, "auth-header-value"),
    authHeaderValue: typeof server.authHeaderValue === "string" ? server.authHeaderValue.trim() : "",
    oauth: healOAuthSettings(server.oauth, id),
    approval: healApproval(server.approval),
    knownTools: healMcpKnownTools(server.knownTools),
    headers: healHeaderMap(server.headers),
    source: healServerSource(server.source),
    ...(typeof server.pluginRoot === "string" && server.pluginRoot.trim() ? { pluginRoot: server.pluginRoot.trim() } : {}),
    enabledTools: healMcpToolGlobs((server as Record<string, unknown>).enabledTools ?? (server as Record<string, unknown>).enabled_tools),
    disabledTools: healMcpToolGlobs((server as Record<string, unknown>).disabledTools ?? (server as Record<string, unknown>).disabled_tools),
  };
}

export const DEFAULT_MCP_SERVER_STATE: McpServerState = {
  enabled: false,
  approval: "ask",
  authType: "none",
  authHeaderName: "",
  authHeaderValueSecretId: "",
  authHeaderValue: "",
  oauth: { ...DEFAULT_MCP_OAUTH_SETTINGS },
  knownTools: [],
  enabledTools: [],
  disabledTools: [],
};

export function healMcpServerState(
  stored: Partial<McpServerState> | null | undefined,
  id: string,
): McpServerState {
  const healedId = normalizeMcpServerId(id);
  // Access the persisted record's dynamic (snake_case legacy) keys through the
  // settings map the same way healMcpServerStateMap does, without a type assertion.
  const raw = stored as unknown;
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { [key: string]: unknown }) : null;
  return {
    enabled: stored?.enabled === true,
    approval: healApproval(stored?.approval),
    authType: healAuthType(stored?.authType, undefined, stored?.authHeaderName),
    authHeaderName: typeof stored?.authHeaderName === "string" ? stored.authHeaderName.trim() : "",
    authHeaderValueSecretId: stringValue(stored?.authHeaderValueSecretId) || mcpSecretId(healedId, "auth-header-value"),
    authHeaderValue: typeof stored?.authHeaderValue === "string" ? stored.authHeaderValue.trim() : "",
    oauth: healOAuthSettings(stored?.oauth, healedId),
    knownTools: healMcpKnownTools(stored?.knownTools),
    ...(typeof record?.lastUrl === "string" && record.lastUrl.trim()
      ? { lastUrl: String(record.lastUrl).trim() }
      : {}),
    enabledTools: healMcpToolGlobs(record?.enabledTools ?? record?.enabled_tools),
    disabledTools: healMcpToolGlobs(record?.disabledTools ?? record?.disabled_tools),
  };
}

export function createMcpServerState(id: string, overrides: Partial<McpServerState> = {}): McpServerState {
  const healedId = normalizeMcpServerId(id);
  const raw = overrides as Record<string, unknown>;
  return {
    enabled: typeof overrides.enabled === "boolean" ? overrides.enabled : false,
    approval: healApproval(overrides.approval),
    authType: healAuthType(overrides.authType, undefined, overrides.authHeaderName),
    authHeaderName: stringValue(overrides.authHeaderName),
    authHeaderValueSecretId: stringValue(overrides.authHeaderValueSecretId) || mcpSecretId(healedId, "auth-header-value"),
    authHeaderValue: stringValue(overrides.authHeaderValue),
    oauth: healOAuthSettings(overrides.oauth, healedId),
    knownTools: healMcpKnownTools(overrides.knownTools),
    ...(typeof overrides.lastUrl === "string" && overrides.lastUrl.trim() ? { lastUrl: overrides.lastUrl.trim() } : {}),
    enabledTools: healMcpToolGlobs(raw.enabledTools ?? raw.enabled_tools ?? overrides.enabledTools),
    disabledTools: healMcpToolGlobs(raw.disabledTools ?? raw.disabled_tools ?? overrides.disabledTools),
  };
}

export function mcpServerStateFromServer(server: McpServerSettings): McpServerState {
  return {
    enabled: server.enabled,
    approval: server.approval,
    authType: server.authType,
    authHeaderName: server.authHeaderName,
    authHeaderValueSecretId: server.authHeaderValueSecretId || mcpSecretId(server.id, "auth-header-value"),
    authHeaderValue: server.authHeaderValue,
    oauth: { ...server.oauth },
    knownTools: [...server.knownTools],
    lastUrl: server.url,
    enabledTools: [...(server.enabledTools ?? [])],
    disabledTools: [...(server.disabledTools ?? [])],
  };
}

export function applyMcpServerState(server: McpServerSettings, state: McpServerState): void {
  server.enabled = state.enabled;
  server.approval = state.approval;
  server.authType = state.authType;
  server.authHeaderName = state.authHeaderName;
  server.authHeaderValueSecretId = state.authHeaderValueSecretId || mcpSecretId(server.id, "auth-header-value");
  server.authHeaderValue = state.authHeaderValue;
  server.oauth = { ...state.oauth };
  server.knownTools = [...state.knownTools];
  server.enabledTools = [...(state.enabledTools ?? [])];
  server.disabledTools = [...(state.disabledTools ?? [])];
  server.authHeaderValueSecretId ||= mcpSecretId(server.id, "auth-header-value");
  ensureMcpOAuthSecretRefs(server.id, server.oauth);
  // lastUrl is tracked in state, not in server shape
}

export function healMcpServerStateMap(
  stored: Record<string, unknown> | null | undefined,
): Record<string, McpServerState> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const healed: Record<string, McpServerState> = {};
  for (const [rawId, value] of Object.entries(stored)) {
    const id = normalizeMcpServerId(rawId);
    if (!id || healed[id]) continue;
    const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<McpServerState>) : null;
    healed[id] = healMcpServerState(record, id);
  }
  return healed;
}

export function createMcpServerSettings(
  overrides: Partial<McpServerSettings> = {},
): McpServerSettings {
  const id = normalizeMcpServerId(overrides.id || overrides.name || serverIdFromMcpUrl(overrides.url) || "mcp");
  const url = stringValue(overrides.url) || "https://";
  const raw = overrides as Record<string, unknown>;
  return {
    id,
    name: stringValue(overrides.name) || "MCP server",
    url,
    enabled: typeof overrides.enabled === "boolean" ? overrides.enabled : Boolean(url && url !== "https://"),
    authType: healAuthType(overrides.authType, undefined, overrides.authHeaderName),
    authHeaderName: stringValue(overrides.authHeaderName),
    authHeaderValueSecretId: stringValue(overrides.authHeaderValueSecretId) || mcpSecretId(id, "auth-header-value"),
    authHeaderValue: stringValue(overrides.authHeaderValue),
    oauth: healOAuthSettings(overrides.oauth, id),
    approval: healApproval(overrides.approval),
    knownTools: healMcpKnownTools(overrides.knownTools),
    headers: healHeaderMap(overrides.headers),
    source: overrides.source ?? "user",
    ...(typeof overrides.pluginRoot === "string" && overrides.pluginRoot.trim()
      ? { pluginRoot: overrides.pluginRoot.trim() }
      : {}),
    enabledTools: healMcpToolGlobs(raw.enabledTools ?? raw.enabled_tools),
    disabledTools: healMcpToolGlobs(raw.disabledTools ?? raw.disabled_tools),
  };
}

function legacyMcpServerPreset(value: unknown): LegacyMcpServerPreset | undefined {
  return value === "generic" || value === "context7" || value === "oauth" ? value : undefined;
}

function healAuthType(
  value: McpAuthType | undefined,
  legacyPreset: LegacyMcpServerPreset | undefined,
  headerName: unknown,
): McpAuthType {
  if (value === "none" || value === "bearer" || value === "header" || value === "oauth") return value;
  if (legacyPreset === "oauth") return "oauth";
  return typeof headerName === "string" && headerName.trim() ? "header" : "none";
}

function healOAuthSettings(stored: Partial<McpOAuthSettings> | null | undefined, serverId: string): McpOAuthSettings {
  const healed = {
    clientId: stringValue(stored?.clientId),
    clientSecretSecretId: stringValue(stored?.clientSecretSecretId),
    clientSecret: stringValue(stored?.clientSecret),
    dynamicClientRegistration: stored?.dynamicClientRegistration === true,
    registeredRedirectUri: stringValue(stored?.registeredRedirectUri),
    authorizationServer: stringValue(stored?.authorizationServer),
    authorizationEndpoint: stringValue(stored?.authorizationEndpoint),
    tokenEndpoint: stringValue(stored?.tokenEndpoint),
    registrationEndpoint: stringValue(stored?.registrationEndpoint),
    resourceMetadataUrl: stringValue(stored?.resourceMetadataUrl),
    accessTokenSecretId: stringValue(stored?.accessTokenSecretId),
    accessToken: stringValue(stored?.accessToken),
    refreshTokenSecretId: stringValue(stored?.refreshTokenSecretId),
    refreshToken: stringValue(stored?.refreshToken),
    expiresAt: typeof stored?.expiresAt === "number" && Number.isFinite(stored.expiresAt) ? stored.expiresAt : 0,
    scope: stringValue(stored?.scope),
  };
  ensureMcpOAuthSecretRefs(serverId, healed);
  return healed;
}

export function mcpOAuthSettingsForServer(serverId: string): McpOAuthSettings {
  const settings = { ...DEFAULT_MCP_OAUTH_SETTINGS };
  ensureMcpOAuthSecretRefs(serverId, settings);
  return settings;
}

export function resetMcpServerSecretRefs(server: McpServerSettings): void {
  server.authHeaderValueSecretId = mcpSecretId(server.id, "auth-header-value");
  resetMcpOAuthSecretRefs(server.id, server.oauth);
}

export function resetMcpOAuthSecretRefs(serverId: string, oauth: McpOAuthSettings): void {
  oauth.clientSecretSecretId = mcpSecretId(serverId, "oauth-client-secret");
  oauth.accessTokenSecretId = mcpSecretId(serverId, "oauth-access-token");
  oauth.refreshTokenSecretId = mcpSecretId(serverId, "oauth-refresh-token");
}

export function resetMcpCredentials(server: McpServerSettings): void {
  server.authHeaderValue = "";
  server.oauth = mcpOAuthSettingsForServer(server.id);
}

export function exportMcpServerConfig(server: McpServerSettings): McpServerExportConfig {
  return {
    kind: "agentic-chat.mcp-server",
    version: 1,
    id: server.id,
    name: server.name,
    url: server.url,
    enabled: server.enabled,
    authType: server.authType,
    authHeaderName: server.authType === "header" ? server.authHeaderName : "",
    approval: server.approval,
    knownTools: server.knownTools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      readOnlyHint: tool.readOnlyHint,
    })),
    ...(server.authType === "oauth"
      ? {
          oauth: {
            clientId: server.oauth.clientId,
            dynamicClientRegistration: server.oauth.dynamicClientRegistration,
            registeredRedirectUri: server.oauth.registeredRedirectUri,
            authorizationServer: server.oauth.authorizationServer,
            authorizationEndpoint: server.oauth.authorizationEndpoint,
            tokenEndpoint: server.oauth.tokenEndpoint,
            registrationEndpoint: server.oauth.registrationEndpoint,
            resourceMetadataUrl: server.oauth.resourceMetadataUrl,
            scope: server.oauth.scope,
          },
        }
      : {}),
  };
}

export function mcpServerEndpointProblem(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed === "https://") return "Paste an HTTPS (or loopback HTTP) Streamable HTTP endpoint.";
  return mcpUrlProblem(trimmed) ?? "";
}

export function mcpServerAuthProblem(server: McpServerSettings): string {
  if (server.authType === "bearer") {
    if (!server.authHeaderValue.trim()) return "Enter a bearer token before testing this MCP server.";
    if (/[\r\n\0]/.test(server.authHeaderValue)) return "Bearer tokens must not contain line breaks or null bytes.";
    return "";
  }
  if (server.authType === "header") {
    if (!server.authHeaderName.trim()) return "Enter an auth header name before testing this MCP server.";
    if (!isValidHttpHeaderName(server.authHeaderName)) {
      return "Auth header names may contain only RFC token characters.";
    }
    if (!server.authHeaderValue.trim()) return "Enter an auth header value before testing this MCP server.";
    if (/[\r\n\0]/.test(server.authHeaderValue)) {
      return "Auth header values must not contain line breaks or null bytes.";
    }
  }
  return "";
}

export function mcpServerSetupSteps(server: McpServerSettings): McpSetupStep[] {
  const endpointProblem = mcpServerEndpointProblem(server.url);
  const authProblem = mcpServerAuthProblem(server);
  const canDiscover = !endpointProblem && !authProblem;
  return [
    {
      id: "endpoint",
      label: "Endpoint",
      status: endpointProblem ? "action" : "complete",
      message: endpointProblem || "HTTPS endpoint is valid.",
    },
    {
      id: "auth",
      label: "Authentication",
      status: authProblem ? "action" : "complete",
      message: authProblem || "Authentication settings are locally valid.",
    },
    {
      id: "discovery",
      label: "Discovery",
      status: discoveryStatus(server, canDiscover),
      message: discoveryMessage(server, canDiscover),
    },
  ];
}

function discoveryStatus(server: McpServerSettings, canDiscover: boolean): McpSetupStepStatus {
  if (server.knownTools.length > 0) return "complete";
  if (canDiscover) return "action";
  return "blocked";
}

function discoveryMessage(server: McpServerSettings, canDiscover: boolean): string {
  if (server.knownTools.length > 0) {
    return `${server.knownTools.length} tool${server.knownTools.length === 1 ? "" : "s"} discovered.`;
  }
  if (canDiscover) {
    return "Run Test connection to discover tools.";
  }
  return "Complete endpoint and authentication before discovery.";
}

function healApproval(value: ApprovalPolicy | undefined): ApprovalPolicy {
  return value === "allow" || value === "ask" || value === "deny" ? value : "ask";
}

function healHeaderMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase() === "authorization") continue;
    if (typeof item === "string") headers[key] = item;
  }
  return headers;
}

function healServerSource(value: unknown): "user" | "plugin" {
  return value === "plugin" ? "plugin" : "user";
}

function healMcpKnownTools(value: unknown): McpKnownToolSettings[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tools: McpKnownToolSettings[] = [];
  for (const item of value) {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const localName = typeof record.localName === "string" ? record.localName.trim() : "";
    const key = localName || name;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    tools.push({
      name,
      ...(localName ? { localName } : {}),
      title: typeof record.title === "string" ? record.title.trim() : "",
      readOnlyHint: record.readOnlyHint === true,
    });
  }
  return tools;
}

export function normalizeMcpServerId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return normalized || "mcp";
}

export function serverIdFromMcpUrl(input: string | undefined): string {
  if (!input) return "";
  try {
    const url = new URL(input);
    return normalizeMcpServerId(url.hostname.replace(/^mcp\./, "").split(".")[0] || "mcp");
  } catch {
    return "";
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniquifyMcpServerIds(servers: McpServerSettings[]): McpServerSettings[] {
  const used = new Set<string>();
  return servers.map((server) => {
    const originalId = server.id;
    server.id = nextUniqueMcpServerId(server.id, used);
    used.add(server.id);
    if (server.id !== originalId) resetMcpServerSecretRefs(server);
    return server;
  });
}

export function nextUniqueMcpServerId(base: string, used: ReadonlySet<string>): string {
  const normalized = normalizeMcpServerId(base);
  if (!used.has(normalized)) return normalized;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${normalized}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${normalized}_${Date.now()}`;
}

function normalizeLegacyMcpServerUrl(server: Partial<McpServerSettings> | null | undefined): string {
  const url = typeof server?.url === "string" ? server.url.trim() : "";
  if (!url) return "";
  const legacy = (server as { legacyFilters?: unknown } | null | undefined)?.legacyFilters;
  const record = legacy && typeof legacy === "object" && !Array.isArray(legacy) ? legacy as Record<string, unknown> : {};
  const toolCategories = legacyString(record.toolCategories);
  const tools = legacyString(record.tools);
  if (!toolCategories && !tools) return url;
  try {
    const parsed = new URL(url);
    if (toolCategories && !parsed.searchParams.has("toolCategories")) {
      parsed.searchParams.set("toolCategories", toolCategories);
    }
    if (tools && !parsed.searchParams.has("tools")) {
      parsed.searchParams.set("tools", tools);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function legacyString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join(",");
  return "";
}

/** @deprecated Use normalizeProxyUrl from src/network/proxy.ts — kept for backwards compat. */
export const normalizeMcpProxyUrl = normalizeProxyUrl;

/** @deprecated Use normalizeNoProxy from src/network/proxy.ts — kept for backwards compat. */
export const normalizeMcpNoProxy = normalizeNoProxy;
