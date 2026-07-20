import type { ApprovalPolicy } from "../agent/approval";
import { ensureMcpOAuthSecretRefs, mcpSecretId } from "../secrets/secret-store";
import { isValidHttpHeaderName } from "./http-headers";

export type McpAuthType = "none" | "bearer" | "header" | "oauth";
type LegacyMcpServerPreset = "generic" | "context7" | "oauth";

export interface McpSettings {
  /**
   * Master egress gate for remote MCP servers. Off by default; when off no MCP
   * tools are registered and no MCP endpoint is contacted.
   */
  enabled: boolean;
  /** Optional HTTP proxy URL used only for remote MCP HTTPS/OAuth requests. */
  proxyUrl: string;
  /** Comma-separated hosts/domains that bypass the MCP proxy. */
  noProxy: string;
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
  proxyUrl: "",
  noProxy: "localhost,127.0.0.1,::1",
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
    proxyUrl: normalizeMcpProxyUrl(stored?.proxyUrl),
    noProxy: normalizeMcpNoProxy(stored?.noProxy),
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
  };
}

export function createMcpServerSettings(
  overrides: Partial<McpServerSettings> = {},
): McpServerSettings {
  const id = normalizeMcpServerId(overrides.id || overrides.name || serverIdFromMcpUrl(overrides.url) || "mcp");
  const url = stringValue(overrides.url) || "https://";
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

export function importMcpServerConfig(value: unknown): McpServerSettings {
  const record = recordValue(value);
  if (record.kind !== "agentic-chat.mcp-server" || record.version !== 1) {
    throw new Error("MCP server config must be an agentic-chat.mcp-server v1 object.");
  }
  const authType = healAuthType(stringValue(record.authType) as McpAuthType, undefined, undefined);
  const server = createMcpServerSettings({
    id: stringValue(record.id) || "mcp",
    name: stringValue(record.name) || stringValue(record.id) || "MCP server",
    url: stringValue(record.url),
    enabled: record.enabled === true,
    authType,
    authHeaderName: authType === "header" ? stringValue(record.authHeaderName) : "",
    approval: healApproval(stringValue(record.approval) as ApprovalPolicy),
    knownTools: healMcpKnownTools(record.knownTools),
  });
  if (authType === "oauth") {
    const oauth = recordValue(record.oauth);
    server.oauth = {
      ...server.oauth,
      clientId: stringValue(oauth.clientId),
      dynamicClientRegistration: oauth.dynamicClientRegistration === true,
      registeredRedirectUri: stringValue(oauth.registeredRedirectUri),
      authorizationServer: stringValue(oauth.authorizationServer),
      authorizationEndpoint: stringValue(oauth.authorizationEndpoint),
      tokenEndpoint: stringValue(oauth.tokenEndpoint),
      registrationEndpoint: stringValue(oauth.registrationEndpoint),
      resourceMetadataUrl: stringValue(oauth.resourceMetadataUrl),
      scope: stringValue(oauth.scope),
    };
  }
  return server;
}

export function mcpServerEndpointProblem(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed === "https://") return "Paste an HTTPS Streamable HTTP endpoint.";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return "MCP server URLs must use https://.";
    return "";
  } catch {
    return "Enter a valid HTTPS MCP server URL.";
  }
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

export function normalizeMcpProxyUrl(input: string | undefined): string {
  if (!input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizeMcpNoProxy(input: string | undefined): string {
  const fallback = DEFAULT_MCP_SETTINGS.noProxy;
  if (!input) return fallback;
  const seen = new Set<string>();
  const values = input
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && /^[a-z0-9.*:[\]_-]+$/.test(part))
    .filter((part) => {
      if (seen.has(part)) return false;
      seen.add(part);
      return true;
    });
  return values.length > 0 ? values.join(",") : fallback;
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

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
