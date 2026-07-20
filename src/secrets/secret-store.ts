import type { App } from "obsidian";
import type { AgenticChatSettings } from "../settings";
import type { McpOAuthSettings, McpServerSettings } from "../mcp/settings";
import {
  OBSERVABILITY_AUTH_HEADER_VALUE_SECRET_ID,
  OBSERVABILITY_LANGFUSE_PUBLIC_KEY_SECRET_ID,
  OBSERVABILITY_LANGFUSE_SECRET_KEY_SECRET_ID,
} from "../observability/settings";

export interface SecretStore {
  getSecret(id: string): string;
  setSecret(id: string, value: string): void;
}

export class ObsidianSecretStore implements SecretStore {
  constructor(private readonly app: App) {}

  getSecret(id: string): string {
    return this.app.secretStorage.getSecret(normalizeSecretId(id)) ?? "";
  }

  setSecret(id: string, value: string): void {
    this.app.secretStorage.setSecret(normalizeSecretId(id), value);
  }
}

export class MemorySecretStore implements SecretStore {
  readonly secrets = new Map<string, string>();

  getSecret(id: string): string {
    return this.secrets.get(normalizeSecretId(id)) ?? "";
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

export function normalizeSecretId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  if (!normalized) throw new Error("Secret id must not be empty.");
  return normalized;
}

export function hydrateSettingsSecrets(settings: AgenticChatSettings, store: SecretStore): void {
  ensureSecretRefs(settings);
  for (const slot of SETTINGS_SECRET_SLOTS) hydrateSettingsSecretSlot(settings, slot, store);
  for (const server of settings.mcp.servers) hydrateMcpServerSecrets(server, store);
}

export function settingsForStorage(settings: AgenticChatSettings, store: SecretStore): AgenticChatSettings {
  ensureSecretRefs(settings);
  const stored = cloneSettings(settings);
  for (const slot of SETTINGS_SECRET_SLOTS) storeSettingsSecretSlot(settings, stored, slot, store);
  for (let index = 0; index < settings.mcp.servers.length; index += 1) {
    storeMcpServerSecrets(settings.mcp.servers[index], stored.mcp.servers[index], store);
  }
  return stored;
}

export function ensureSecretRefs(settings: AgenticChatSettings): void {
  for (const slot of SETTINGS_SECRET_SLOTS) {
    if (!stringAt(settings, slot.secretIdPath).trim()) writePath(settings, slot.secretIdPath, slot.defaultSecretId);
  }
  for (const server of settings.mcp.servers) ensureMcpServerSecretRefs(server);
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

function hydrateMcpServerSecrets(server: McpServerSettings, store: SecretStore): void {
  ensureMcpServerSecretRefs(server);
  hydrateSecretSlot(server, "authHeaderValue", server.authHeaderValueSecretId, store);
  hydrateSecretSlot(server.oauth, "clientSecret", server.oauth.clientSecretSecretId, store);
  hydrateSecretSlot(server.oauth, "accessToken", server.oauth.accessTokenSecretId, store);
  hydrateSecretSlot(server.oauth, "refreshToken", server.oauth.refreshTokenSecretId, store);
}

function storeMcpServerSecrets(runtime: McpServerSettings, stored: McpServerSettings, store: SecretStore): void {
  ensureMcpServerSecretRefs(runtime);
  stored.authHeaderValueSecretId = runtime.authHeaderValueSecretId;
  storeSecretSlot(runtime, stored, "authHeaderValue", runtime.authHeaderValueSecretId, store);
  storeMcpOAuthSecrets(runtime.id, runtime.oauth, stored.oauth, store);
}

function storeMcpOAuthSecrets(
  serverId: string,
  runtime: McpOAuthSettings,
  stored: McpOAuthSettings,
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

function storeSecretSlot<T extends Record<K, string>, K extends string>(
  runtime: T,
  stored: T,
  key: K,
  secretId: string,
  store: SecretStore,
): void {
  const value = typeof runtime[key] === "string" ? runtime[key].trim() : "";
  store.setSecret(secretId, value);
  stored[key] = "" as T[K];
}

function hydrateSettingsSecretSlot(settings: AgenticChatSettings, slot: SettingsSecretSlot, store: SecretStore): void {
  if (stringAt(settings, slot.valuePath).trim()) return;
  const stored = store.getSecret(stringAt(settings, slot.secretIdPath)).trim();
  if (stored) writePath(settings, slot.valuePath, stored);
}

function storeSettingsSecretSlot(
  runtime: AgenticChatSettings,
  stored: AgenticChatSettings,
  slot: SettingsSecretSlot,
  store: SecretStore,
): void {
  const value = stringAt(runtime, slot.valuePath).trim();
  store.setSecret(stringAt(runtime, slot.secretIdPath), value);
  writePath(stored, slot.valuePath, "");
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
  if (!root || typeof root !== "object") return;
  let current = root as Record<string, unknown>;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!next || typeof next !== "object") return;
    current = next as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

function cloneSettings(settings: AgenticChatSettings): AgenticChatSettings {
  return structuredClone(settings) as AgenticChatSettings;
}
