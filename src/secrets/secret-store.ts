import type { App } from "obsidian";
import type { AgenticChatSettings } from "../settings";
import type { WebSettings } from "../settings-schema";
import type {
  McpOAuthSettings,
  McpServerSettings,
  McpServerState,
  McpSettings,
} from "../mcp/settings";
import type { PluginSettings } from "../plugins/settings";
import { sha256Hex } from "../utils/sha256";
import {
  OBSERVABILITY_AUTH_HEADER_VALUE_SECRET_ID,
  OBSERVABILITY_LANGFUSE_PUBLIC_KEY_SECRET_ID,
  OBSERVABILITY_LANGFUSE_SECRET_KEY_SECRET_ID,
  type ObservabilitySettings,
} from "../observability/settings";

export interface SecretStore {
  getSecret(id: string): string;
  setSecret(id: string, value: string): void;
}

export class ObsidianSecretStore implements SecretStore {
  constructor(private readonly app: App) {}

  getSecret(id: string): string {
    const normalized = normalizeSecretId(id);
    const value = this.app.secretStorage.getSecret(normalized) ?? "";
    if (value) return value;
    // Backward compat: pre-plugins ids were truncated to 120 chars instead of
    // hashed, so a long id stored under the old scheme resolves differently.
    const legacy = legacySecretId(id);
    if (legacy !== normalized) return this.app.secretStorage.getSecret(legacy) ?? "";
    return "";
  }

  setSecret(id: string, value: string): void {
    this.app.secretStorage.setSecret(normalizeSecretId(id), value);
  }
}

export class MemorySecretStore implements SecretStore {
  readonly secrets = new Map<string, string>();

  getSecret(id: string): string {
    const normalized = normalizeSecretId(id);
    const value = this.secrets.get(normalized) ?? "";
    if (value) return value;
    const legacy = legacySecretId(id);
    if (legacy !== normalized) return this.secrets.get(legacy) ?? "";
    return "";
  }

  setSecret(id: string, value: string): void {
    this.secrets.set(normalizeSecretId(id), value);
  }
}

export const OPENROUTER_API_KEY_SECRET_ID = "agentic-chat-openrouter-api-key";
export const OPENAI_COMPATIBLE_API_KEY_SECRET_ID = "agentic-chat-openai-compatible-api-key";
export const WEB_SEARCH_API_KEY_SECRET_ID = "agentic-chat-web-search-api-key";

type SettingsSecretSlot = {
  readonly valuePath: readonly string[];
  readonly secretIdPath: readonly string[];
  readonly defaultSecretId: string;
};

export const SETTINGS_SECRET_SLOTS: readonly SettingsSecretSlot[] = [
  {
    valuePath: ["openrouterApiKey"],
    secretIdPath: ["openrouterApiKeySecretId"],
    defaultSecretId: OPENROUTER_API_KEY_SECRET_ID,
  },
  {
    valuePath: ["openaiCompatibleApiKey"],
    secretIdPath: ["openaiCompatibleApiKeySecretId"],
    defaultSecretId: OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
  },
  {
    valuePath: ["web", "searchApiKey"],
    secretIdPath: ["web", "searchApiKeySecretId"],
    defaultSecretId: WEB_SEARCH_API_KEY_SECRET_ID,
  },
  {
    valuePath: ["observability", "langfusePublicKey"],
    secretIdPath: ["observability", "langfusePublicKeySecretId"],
    defaultSecretId: OBSERVABILITY_LANGFUSE_PUBLIC_KEY_SECRET_ID,
  },
  {
    valuePath: ["observability", "langfuseSecretKey"],
    secretIdPath: ["observability", "langfuseSecretKeySecretId"],
    defaultSecretId: OBSERVABILITY_LANGFUSE_SECRET_KEY_SECRET_ID,
  },
  {
    valuePath: ["observability", "authHeaderValue"],
    secretIdPath: ["observability", "authHeaderValueSecretId"],
    defaultSecretId: OBSERVABILITY_AUTH_HEADER_VALUE_SECRET_ID,
  },
];

export function mcpSecretId(serverId: string, kind: string): string {
  return normalizeSecretId(`agentic-chat-mcp-${serverId}-${kind}`);
}

/** Omit plaintext secret keys from a settings shape; persisted JSON carries only secretStorage refs. */
type WithoutPlaintext<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type PersistedMcpOAuthSettings = WithoutPlaintext<
  McpOAuthSettings,
  "clientSecret" | "accessToken" | "refreshToken"
>;
export type PersistedMcpServerSettings = WithoutPlaintext<McpServerSettings, "authHeaderValue"> & {
  oauth: PersistedMcpOAuthSettings;
};
export type PersistedMcpServerState = WithoutPlaintext<McpServerState, "authHeaderValue"> & {
  oauth: PersistedMcpOAuthSettings;
};

/**
 * Persisted data.json shape: same as runtime settings but every plaintext
 * secret key is omitted entirely (never `""`). Do NOT use as runtime
 * `AgenticChatSettings` — omitted keys would throw on `.trim()`. Only
 * `saveData` consumes this; runtime always goes through `mergeSettings` +
 * `hydrateSettingsSecrets`.
 */
export type PersistedSettings = WithoutPlaintext<
  AgenticChatSettings,
  "openrouterApiKey" | "openaiCompatibleApiKey"
> & {
  web: WithoutPlaintext<WebSettings, "searchApiKey">;
  observability: WithoutPlaintext<
    ObservabilitySettings,
    "langfusePublicKey" | "langfuseSecretKey" | "authHeaderValue"
  >;
  mcp: Omit<McpSettings, "servers"> & { servers: PersistedMcpServerSettings[] };
  plugins: Omit<PluginSettings, "mcpState"> & { mcpState: Record<string, PersistedMcpServerState> };
};

/** Sanitize a secret id to Obsidian-safe characters (no length cap). */
function sanitizeSecretId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeSecretId(input: string): string {
  const normalized = sanitizeSecretId(input);
  if (!normalized) throw new Error("Secret id must not be empty.");
  // Obsidian's native secret store caps ids at 64 chars. Truncating the tail
  // would collapse the distinguishing kind suffix (auth-header-value vs
  // oauth-client-secret), so long ids keep a readable prefix plus a truncated
  // SHA-256 of the full id.
  if (normalized.length <= 64) return normalized;
  return `${normalized.slice(0, 51)}-${sha256Hex(normalized).slice(0, 12)}`;
}

/** The id the pre-plugins secret store used (sanitized, truncated to 120 chars). */
export function legacySecretId(input: string): string {
  return sanitizeSecretId(input).slice(0, 120);
}

export function hydrateSettingsSecrets(settings: AgenticChatSettings, store: SecretStore): void {
  ensureSecretRefs(settings);
  for (const slot of SETTINGS_SECRET_SLOTS) hydrateSettingsSecretSlot(settings, slot, store);
  for (const server of settings.mcp.servers) hydrateMcpServerSecrets(server, store);
  for (const [id, state] of Object.entries(settings.plugins.mcpState ?? {})) hydrateMcpStateSecrets(id, state, store);
}

export function settingsForStorage(settings: AgenticChatSettings, store: SecretStore): PersistedSettings {
  ensureSecretRefs(settings);
  const stored = cloneSettings(settings) as unknown as PersistedSettings;
  for (const slot of SETTINGS_SECRET_SLOTS) storeSettingsSecretSlot(settings, stored, slot, store);
  for (let index = 0; index < settings.mcp.servers.length; index += 1) {
    storeMcpServerSecrets(settings.mcp.servers[index], stored.mcp.servers[index], store);
  }
  for (const [id, state] of Object.entries(settings.plugins.mcpState ?? {})) {
    const storedState = stored.plugins.mcpState?.[id];
    if (storedState) storeMcpStateSecrets(id, state, storedState, store);
  }
  return stored;
}

export function ensureSecretRefs(settings: AgenticChatSettings): void {
  for (const slot of SETTINGS_SECRET_SLOTS) {
    if (!stringAt(settings, slot.secretIdPath).trim()) writePath(settings, slot.secretIdPath, slot.defaultSecretId);
  }
  for (const server of settings.mcp.servers) ensureMcpServerSecretRefs(server);
  for (const [id, state] of Object.entries(settings.plugins.mcpState ?? {})) ensureMcpStateSecretRefs(id, state);
}

export function ensureMcpServerSecretRefs(server: McpServerSettings): void {
  server.authHeaderValueSecretId ||= mcpSecretId(server.id, "auth-header-value");
  ensureMcpOAuthSecretRefs(server.id, server.oauth);
}

export function ensureMcpOAuthSecretRefs(serverId: string, oauth: McpOAuthSettings): void {
  oauth.clientSecretSecretId ||= mcpSecretId(serverId, "oauth-client-secret");
  oauth.accessTokenSecretId ||= mcpSecretId(serverId, "oauth-access-token");
  oauth.refreshTokenSecretId ||= mcpSecretId(serverId, "oauth-refresh-token");
}

export function ensureMcpStateSecretRefs(id: string, state: McpServerState): void {
  state.authHeaderValueSecretId ||= mcpSecretId(id, "auth-header-value");
  ensureMcpOAuthSecretRefs(id, state.oauth);
}

function hydrateMcpServerSecrets(server: McpServerSettings, store: SecretStore): void {
  ensureMcpServerSecretRefs(server);
  hydrateSecretSlot(server, "authHeaderValue", server.authHeaderValueSecretId, store);
  hydrateSecretSlot(server.oauth, "clientSecret", server.oauth.clientSecretSecretId, store);
  hydrateSecretSlot(server.oauth, "accessToken", server.oauth.accessTokenSecretId, store);
  hydrateSecretSlot(server.oauth, "refreshToken", server.oauth.refreshTokenSecretId, store);
}

function storeMcpServerSecrets(
  runtime: McpServerSettings,
  stored: PersistedMcpServerSettings,
  store: SecretStore,
): void {
  ensureMcpServerSecretRefs(runtime);
  stored.authHeaderValueSecretId = runtime.authHeaderValueSecretId;
  storeSecretSlot(runtime, stored, "authHeaderValue", runtime.authHeaderValueSecretId, store);
  storeMcpOAuthSecrets(runtime.id, runtime.oauth, stored.oauth, store);
}

function storeMcpOAuthSecrets(
  serverId: string,
  runtime: McpOAuthSettings,
  stored: PersistedMcpOAuthSettings,
  store: SecretStore,
): void {
  ensureMcpOAuthSecretRefs(serverId, runtime);
  stored.clientSecretSecretId = runtime.clientSecretSecretId;
  stored.accessTokenSecretId = runtime.accessTokenSecretId;
  stored.refreshTokenSecretId = runtime.refreshTokenSecretId;
  storeSecretSlot(runtime, stored, "clientSecret", runtime.clientSecretSecretId, store);
  storeSecretSlot(runtime, stored, "accessToken", runtime.accessTokenSecretId, store);
  storeSecretSlot(runtime, stored, "refreshToken", runtime.refreshTokenSecretId, store);
}

function hydrateMcpStateSecrets(id: string, state: McpServerState, store: SecretStore): void {
  ensureMcpStateSecretRefs(id, state);
  hydrateSecretSlot(state, "authHeaderValue", state.authHeaderValueSecretId, store);
  hydrateSecretSlot(state.oauth, "clientSecret", state.oauth.clientSecretSecretId, store);
  hydrateSecretSlot(state.oauth, "accessToken", state.oauth.accessTokenSecretId, store);
  hydrateSecretSlot(state.oauth, "refreshToken", state.oauth.refreshTokenSecretId, store);
}

function storeMcpStateSecrets(
  id: string,
  runtime: McpServerState,
  stored: PersistedMcpServerState,
  store: SecretStore,
): void {
  ensureMcpStateSecretRefs(id, runtime);
  stored.authHeaderValueSecretId = runtime.authHeaderValueSecretId;
  storeSecretSlot(runtime, stored, "authHeaderValue", runtime.authHeaderValueSecretId, store);
  storeMcpOAuthSecrets(id, runtime.oauth, stored.oauth, store);
}

function hydrateSecretSlot<T extends Record<K, string>, K extends string>(
  target: T,
  key: K,
  secretId: string,
  store: SecretStore,
): void {
  if (typeof target[key] === "string" && target[key].trim()) return;
  const stored = store.getSecret(secretId).trim();
  if (stored) target[key] = stored as T[K];
}

function storeSecretSlot<TRuntime, TStored, K extends Extract<keyof TRuntime & keyof TStored, string>>(
  runtime: TRuntime,
  stored: TStored,
  key: K,
  secretId: string,
  store: SecretStore,
): void {
  const raw: unknown = (runtime as Record<string, unknown>)[key];
  // Absent (non-string) runtime value must not wipe a good secret: with JSON
  // omission there is no persisted backup. Only an explicit "" clears.
  if (typeof raw !== "string") {
    delete (stored as Record<string, unknown>)[key];
    return;
  }
  store.setSecret(secretId, raw.trim());
  delete (stored as Record<string, unknown>)[key];
}

function hydrateSettingsSecretSlot(settings: AgenticChatSettings, slot: SettingsSecretSlot, store: SecretStore): void {
  if (stringAt(settings, slot.valuePath).trim()) return;
  const stored = store.getSecret(stringAt(settings, slot.secretIdPath)).trim();
  if (stored) writePath(settings, slot.valuePath, stored);
}

function storeSettingsSecretSlot(
  runtime: AgenticChatSettings,
  stored: PersistedSettings,
  slot: SettingsSecretSlot,
  store: SecretStore,
): void {
  const raw = readPath(runtime, slot.valuePath);
  // Absent (non-string) runtime value must not wipe a good secret (see storeSecretSlot).
  if (typeof raw !== "string") {
    deletePath(stored, slot.valuePath);
    return;
  }
  store.setSecret(stringAt(runtime, slot.secretIdPath), raw.trim());
  deletePath(stored, slot.valuePath);
}

function stringAt(root: unknown, path: readonly string[]): string {
  const value = readPath(root, path);
  return typeof value === "string" ? value : "";
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(root: unknown, path: readonly string[], value: string): void {
  const parent = parentOf(root, path);
  if (!parent) return;
  parent[path[path.length - 1]] = value;
}

function deletePath(root: unknown, path: readonly string[]): void {
  const parent = parentOf(root, path);
  if (!parent) return;
  delete parent[path[path.length - 1]];
}

function parentOf(root: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  if (!root || typeof root !== "object") return undefined;
  let current = root as Record<string, unknown>;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!next || typeof next !== "object") return undefined;
    current = next as Record<string, unknown>;
  }
  return current;
}

function cloneSettings(settings: AgenticChatSettings): AgenticChatSettings {
  return structuredClone(settings);
}
