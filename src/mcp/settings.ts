import type { ApprovalPolicy } from "../agent/approval";
import { DEFAULT_PROXY_SETTINGS, type ProxySettings, normalizeNoProxy, normalizeProxyUrl } from "../network/proxy";
import { ensureMcpScopeRefs, mcpSecretId } from "../secrets/secret-ids";
import { isValidHttpHeaderName } from "./http-headers";
import { mcpUrlProblem } from "../utils/host-policy";
import { healMcpToolGlobs } from "./tool-filter";

export type McpAuthType = "none" | "bearer" | "header" | "oauth";

export interface McpSettings extends ProxySettings {
  /**
   * Master egress gate for remote MCP servers. Off by default; when off no MCP
   * tools are registered and no MCP endpoint is contacted.
   */
  enabled: boolean;
}

/**
 * Client-owned fields shared by the persisted settings shape and the plugin
 * state map. One base type keeps the two from drifting apart field by field.
 */
export interface McpServerOwnedFields {
  enabled: boolean;
  /** Authentication mechanism for this remote MCP server. */
  authType: McpAuthType;
  /** Optional auth header name for custom static-header authentication. */
  authHeaderName: string;
  /** Optional bearer token or custom auth header value. */
  authHeaderValueSecretId: string;
  /** Runtime-only in-memory secret cache, hydrated from Obsidian secretStorage through {@link authHeaderValueSecretId}. Never persisted. */
  authHeaderValue: string;
  /** OAuth state and tokens for remote MCP servers that use MCP authorization. */
  oauth: McpOAuthSettings;
  /** Gate every tool call from this server; remote annotations are not trusted. */
  approval: ApprovalPolicy;
  /** Last discovered tools, cached only to render per-tool approval controls. */
  knownTools: McpKnownToolSettings[];
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
  /** Last WWW-Authenticate challenge; kept so a redraw or reload can show the banner until authentication succeeds. */
  pendingOAuthChallenge?: string;
  pendingOAuthResourceUrl?: string;
}

export interface McpServerSettings extends McpServerOwnedFields {
  /** Stable local id used in exposed tool names: mcp__<id>__<tool>. */
  id: string;
  /** User-facing server name. */
  name: string;
  /** Streamable HTTP endpoint, e.g. https://mcp.example.com/mcp. */
  url: string;
  /**
   * Literal headers from a plugin's mcp.json. Client-generated headers
   * (MCP protocol, auth) take precedence per the Agent Plugins spec.
   */
  headers: Record<string, string>;
  /** Where this server configuration came from. */
  source: "user" | "plugin";
  /** Vault path of the plugin package that declared this server, when plugin-sourced. */
  pluginRoot?: string;
}

/** Client-owned state for a plugin-derived MCP server (shape lives in mcp.json). */
export interface McpServerState extends McpServerOwnedFields {
  /** Last known URL for change detection — cleared auth if mcp.json moves host. */
  lastUrl?: string;
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

export interface McpOAuthSettings {
  clientId: string;
  clientSecretSecretId: string;
  /** Runtime-only in-memory secret cache, hydrated from Obsidian secretStorage through {@link clientSecretSecretId}. Never persisted. */
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
  /** Runtime-only in-memory secret cache, hydrated from Obsidian secretStorage through {@link accessTokenSecretId}. Never persisted. */
  accessToken: string;
  refreshTokenSecretId: string;
  /** Runtime-only in-memory secret cache, hydrated from Obsidian secretStorage through {@link refreshTokenSecretId}. Never persisted. */
  refreshToken: string;
  /** Unix epoch milliseconds. 0 means unknown/non-expiring. */
  expiresAt: number;
  scope: string;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  ...DEFAULT_PROXY_SETTINGS,
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
  return {
    enabled: stored?.enabled === true,
    proxyUrl: normalizeProxyUrl(stored?.proxyUrl),
    noProxy: normalizeNoProxy(stored?.noProxy),
  };
}

/** `heal` normalizes persisted/raw input; `copy` mirrors a live record unchanged. */
type McpServerBuildMode = "heal" | "copy";

interface McpServerBuildOptions {
  id: string;
  mode: McpServerBuildMode;
  /** Caller-built overrides keep plaintext; persisted data never does. */
  includePlaintext: boolean;
  /** `trim` for state, `raw` for persisted settings, omitted by the settings generator. */
  pending: "trim" | "raw" | "omit";
}

interface McpServerBuildInput {
  enabled: boolean;
  approval: unknown;
  authType: unknown;
  authHeaderName: unknown;
  authHeaderValueSecretId: unknown;
  authHeaderValue: unknown;
  oauth: Partial<McpOAuthSettings> | null | undefined;
  knownTools: unknown;
  enabledTools: unknown;
  disabledTools: unknown;
  pendingOAuthChallenge: unknown;
  pendingOAuthResourceUrl: unknown;
}

/** One place for the 12 shared fields; the six builders below are wrappers. */
function buildMcpServer(input: McpServerBuildInput, options: McpServerBuildOptions): McpServerOwnedFields {
  const copy = options.mode === "copy";
  const owned: McpServerOwnedFields = {
    enabled: input.enabled,
    approval: copy ? (input.approval as ApprovalPolicy) : healApproval(input.approval as ApprovalPolicy | undefined),
    authType: copy
      ? (input.authType as McpAuthType)
      : healAuthType(input.authType as McpAuthType | undefined, input.authHeaderName),
    authHeaderName: copy
      ? ((input.authHeaderName as string | undefined) ?? "")
      : stringValue(input.authHeaderName),
    authHeaderValueSecretId:
      (copy
        ? ((input.authHeaderValueSecretId as string | undefined) ?? "")
        : stringValue(input.authHeaderValueSecretId)) || mcpSecretId(options.id, "auth-header-value"),
    authHeaderValue: copy
      ? ((input.authHeaderValue as string | undefined) ?? "")
      : options.includePlaintext
        ? stringValue(input.authHeaderValue)
        : "",
    oauth: copy
      ? { ...(input.oauth as McpOAuthSettings) }
      : healOAuthSettings(input.oauth, options.id, options.includePlaintext),
    knownTools: copy
      ? [...((input.knownTools as McpKnownToolSettings[] | undefined) ?? [])]
      : healMcpKnownTools(input.knownTools),
    enabledTools: copy
      ? [...((input.enabledTools as string[] | undefined) ?? [])]
      : healMcpToolGlobs(input.enabledTools),
    disabledTools: copy
      ? [...((input.disabledTools as string[] | undefined) ?? [])]
      : healMcpToolGlobs(input.disabledTools),
  };
  if (options.pending === "omit") return owned;
  if (copy) {
    // State-from-server keeps the keys present, even when undefined.
    return {
      ...owned,
      pendingOAuthChallenge: input.pendingOAuthChallenge as string | undefined,
      pendingOAuthResourceUrl: input.pendingOAuthResourceUrl as string | undefined,
    };
  }
  const trim = options.pending === "trim";
  const challenge = trim
    ? stringValue(input.pendingOAuthChallenge)
    : typeof input.pendingOAuthChallenge === "string" && input.pendingOAuthChallenge
      ? input.pendingOAuthChallenge
      : "";
  const resourceUrl = trim
    ? stringValue(input.pendingOAuthResourceUrl)
    : typeof input.pendingOAuthResourceUrl === "string" && input.pendingOAuthResourceUrl
      ? input.pendingOAuthResourceUrl
      : "";
  return {
    ...owned,
    ...(challenge ? { pendingOAuthChallenge: challenge } : {}),
    ...(resourceUrl ? { pendingOAuthResourceUrl: resourceUrl } : {}),
  };
}

function ownedInput(record: Record<string, unknown>, enabled: boolean): McpServerBuildInput {
  return {
    enabled,
    approval: record.approval,
    authType: record.authType,
    authHeaderName: record.authHeaderName,
    authHeaderValueSecretId: record.authHeaderValueSecretId,
    authHeaderValue: record.authHeaderValue,
    oauth: record.oauth as McpServerBuildInput["oauth"],
    knownTools: record.knownTools,
    enabledTools: record.enabledTools ?? record.enabled_tools,
    disabledTools: record.disabledTools ?? record.disabled_tools,
    pendingOAuthChallenge: record.pendingOAuthChallenge,
    pendingOAuthResourceUrl: record.pendingOAuthResourceUrl,
  };
}

export function healMcpServerState(
  stored: Partial<McpServerState> | null | undefined,
  id: string,
): McpServerState {
  const healedId = normalizeMcpServerId(id);
  const record =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as { [key: string]: unknown })
      : null;
  return {
    ...buildMcpServer(ownedInput(record ?? {}, stored?.enabled === true), {
      id: healedId,
      mode: "heal",
      includePlaintext: false,
      pending: "trim",
    }),
    ...(typeof record?.lastUrl === "string" && record.lastUrl.trim() ? { lastUrl: record.lastUrl.trim() } : {}),
  };
}

export function createMcpServerState(id: string, overrides: Partial<McpServerState> = {}): McpServerState {
  const healedId = normalizeMcpServerId(id);
  const raw = overrides as Record<string, unknown>;
  return {
    ...buildMcpServer(ownedInput(raw, typeof overrides.enabled === "boolean" ? overrides.enabled : false), {
      id: healedId,
      mode: "heal",
      includePlaintext: true,
      pending: "trim",
    }),
    ...(typeof overrides.lastUrl === "string" && overrides.lastUrl.trim() ? { lastUrl: overrides.lastUrl.trim() } : {}),
  };
}

export function mcpServerStateFromServer(server: McpServerSettings): McpServerState {
  return {
    ...buildMcpServer(ownedInput(server as unknown as Record<string, unknown>, server.enabled), {
      id: server.id,
      mode: "copy",
      includePlaintext: true,
      pending: "raw",
    }),
    lastUrl: server.url,
  };
}

export function applyMcpServerState(server: McpServerSettings, state: McpServerState): void {
  Object.assign(
    server,
    buildMcpServer(ownedInput(state as unknown as Record<string, unknown>, state.enabled), {
      id: server.id,
      mode: "copy",
      includePlaintext: true,
      pending: "raw",
    }),
  );
  ensureMcpScopeRefs(server.id, server.oauth, "oauth");
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
    ...buildMcpServer(
      ownedInput(raw, typeof overrides.enabled === "boolean" ? overrides.enabled : Boolean(url && url !== "https://")),
      { id, mode: "heal", includePlaintext: true, pending: "omit" },
    ),
    headers: healHeaderMap(overrides.headers),
    source: overrides.source ?? "user",
    ...(typeof overrides.pluginRoot === "string" && overrides.pluginRoot.trim()
      ? { pluginRoot: overrides.pluginRoot.trim() }
      : {}),
  };
}

function healAuthType(value: McpAuthType | undefined, headerName: unknown): McpAuthType {
  if (value === "none" || value === "bearer" || value === "header" || value === "oauth") return value;
  return typeof headerName === "string" && headerName.trim() ? "header" : "none";
}

function healOAuthSettings(
  stored: Partial<McpOAuthSettings> | null | undefined,
  serverId: string,
  /** Read plaintext from a caller-built override; persisted data is migrated first and passes false. */
  includePlaintext: boolean,
): McpOAuthSettings {
  const healed = {
    clientId: stringValue(stored?.clientId),
    clientSecretSecretId: stringValue(stored?.clientSecretSecretId),
    clientSecret: includePlaintext ? stringValue(stored?.clientSecret) : "",
    dynamicClientRegistration: stored?.dynamicClientRegistration === true,
    registeredRedirectUri: stringValue(stored?.registeredRedirectUri),
    authorizationServer: stringValue(stored?.authorizationServer),
    authorizationEndpoint: stringValue(stored?.authorizationEndpoint),
    tokenEndpoint: stringValue(stored?.tokenEndpoint),
    registrationEndpoint: stringValue(stored?.registrationEndpoint),
    resourceMetadataUrl: stringValue(stored?.resourceMetadataUrl),
    accessTokenSecretId: stringValue(stored?.accessTokenSecretId),
    accessToken: includePlaintext ? stringValue(stored?.accessToken) : "",
    refreshTokenSecretId: stringValue(stored?.refreshTokenSecretId),
    refreshToken: includePlaintext ? stringValue(stored?.refreshToken) : "",
    expiresAt: typeof stored?.expiresAt === "number" && Number.isFinite(stored.expiresAt) ? stored.expiresAt : 0,
    scope: stringValue(stored?.scope),
  };
  ensureMcpScopeRefs(serverId, healed, "oauth");
  return healed;
}

export function mcpOAuthSettingsForServer(serverId: string): McpOAuthSettings {
  const settings = { ...DEFAULT_MCP_OAUTH_SETTINGS };
  ensureMcpScopeRefs(serverId, settings, "oauth");
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

export function nextUniqueMcpServerId(base: string, used: ReadonlySet<string>): string {
  const normalized = normalizeMcpServerId(base);
  if (!used.has(normalized)) return normalized;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${normalized}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${normalized}_${Date.now()}`;
}

