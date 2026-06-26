import type { App } from "obsidian";
import type { AgenticChatSettings } from "../settings";
import type { McpOAuthSettings, McpServerSettings } from "../mcp/settings";

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
  hydrateSecretSlot(settings, "openrouterApiKey", settings.openrouterApiKeySecretId, store);
  hydrateSecretSlot(settings, "openaiCompatibleApiKey", settings.openaiCompatibleApiKeySecretId, store);
  hydrateSecretSlot(settings.web, "searchApiKey", settings.web.searchApiKeySecretId, store);
  for (const server of settings.mcp.servers) hydrateMcpServerSecrets(server, store);
}

export function settingsForStorage(settings: AgenticChatSettings, store: SecretStore): AgenticChatSettings {
  ensureSecretRefs(settings);
  const stored = cloneSettings(settings);
  storeSecretSlot(settings, stored, "openrouterApiKey", settings.openrouterApiKeySecretId, store);
  storeSecretSlot(settings, stored, "openaiCompatibleApiKey", settings.openaiCompatibleApiKeySecretId, store);
  storeSecretSlot(settings.web, stored.web, "searchApiKey", settings.web.searchApiKeySecretId, store);
  for (let index = 0; index < settings.mcp.servers.length; index += 1) {
    storeMcpServerSecrets(settings.mcp.servers[index], stored.mcp.servers[index], store);
  }
  return stored;
}

export function ensureSecretRefs(settings: AgenticChatSettings): void {
  settings.openrouterApiKeySecretId ||= OPENROUTER_API_KEY_SECRET_ID;
  settings.openaiCompatibleApiKeySecretId ||= OPENAI_COMPATIBLE_API_KEY_SECRET_ID;
  settings.web.searchApiKeySecretId ||= WEB_SEARCH_API_KEY_SECRET_ID;
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
  if (target[key].trim()) return;
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
  store.setSecret(secretId, runtime[key].trim());
  stored[key] = "" as T[K];
}

function cloneSettings(settings: AgenticChatSettings): AgenticChatSettings {
  return JSON.parse(JSON.stringify(settings)) as AgenticChatSettings;
}
