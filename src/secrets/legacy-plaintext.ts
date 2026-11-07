import {
  OBSERVABILITY_AUTH_HEADER_VALUE_SECRET_ID,
  OBSERVABILITY_LANGFUSE_PUBLIC_KEY_SECRET_ID,
  OBSERVABILITY_LANGFUSE_SECRET_KEY_SECRET_ID,
} from "../observability/settings";
import {
  mcpSecretId,
  OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
  OPENROUTER_API_KEY_SECRET_ID,
  WEB_SEARCH_API_KEY_SECRET_ID,
  type SecretStore,
} from "./secret-store";

/**
 * One-time migration of the plaintext secret keys that pre-secretStorage
 * data.json files carried. The legacy keys are read once, written to the
 * secret store, and then deleted from the raw stored object before
 * `mergeSettings` runs. No deprecated plaintext field is part of the public
 * settings surface; runtime settings only hold an in-memory secret cache that
 * `hydrateSettingsSecrets` fills from the store.
 *
 * The migration is idempotent: a second load has no legacy keys to move.
 */
export function migrateLegacyPlaintextSecrets(stored: unknown, store: SecretStore): void {
  const root = asRecord(stored);
  if (!root) return;

  takeSecret(root, "openrouterApiKey", "openrouterApiKeySecretId", OPENROUTER_API_KEY_SECRET_ID, store);
  takeSecret(
    root,
    "openaiCompatibleApiKey",
    "openaiCompatibleApiKeySecretId",
    OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
    store,
  );

  const web = asRecord(root.web);
  if (web) takeSecret(web, "searchApiKey", "searchApiKeySecretId", WEB_SEARCH_API_KEY_SECRET_ID, store);

  const observability = asRecord(root.observability);
  if (observability) {
    takeSecret(
      observability,
      "langfusePublicKey",
      "langfusePublicKeySecretId",
      OBSERVABILITY_LANGFUSE_PUBLIC_KEY_SECRET_ID,
      store,
    );
    takeSecret(
      observability,
      "langfuseSecretKey",
      "langfuseSecretKeySecretId",
      OBSERVABILITY_LANGFUSE_SECRET_KEY_SECRET_ID,
      store,
    );
    takeSecret(
      observability,
      "authHeaderValue",
      "authHeaderValueSecretId",
      OBSERVABILITY_AUTH_HEADER_VALUE_SECRET_ID,
      store,
    );
  }

  for (const rawServer of asArray(asRecord(root.mcp)?.servers)) {
    const server = asRecord(rawServer);
    if (!server) continue;
    migrateMcpRecord(server, stringValue(server.id) || "server", store);
  }

  const mcpState = asRecord(asRecord(root.plugins)?.mcpState);
  for (const [id, rawState] of Object.entries(mcpState ?? {})) {
    const state = asRecord(rawState);
    if (state) migrateMcpRecord(state, id || "server", store);
  }
}

function migrateMcpRecord(record: Record<string, unknown>, serverId: string, store: SecretStore): void {
  takeSecret(
    record,
    "authHeaderValue",
    "authHeaderValueSecretId",
    mcpSecretId(serverId, "auth-header-value"),
    store,
  );
  const oauth = asRecord(record.oauth);
  if (!oauth) return;
  takeSecret(oauth, "clientSecret", "clientSecretSecretId", mcpSecretId(serverId, "oauth-client-secret"), store);
  takeSecret(oauth, "accessToken", "accessTokenSecretId", mcpSecretId(serverId, "oauth-access-token"), store);
  takeSecret(oauth, "refreshToken", "refreshTokenSecretId", mcpSecretId(serverId, "oauth-refresh-token"), store);
}

/** Read and remove one legacy plaintext value, writing it to the secret store when non-empty. */
function takeSecret(
  record: Record<string, unknown>,
  valueKey: string,
  secretIdKey: string,
  defaultSecretId: string,
  store: SecretStore,
): void {
  const value = record[valueKey];
  delete record[valueKey];
  if (typeof value !== "string" || !value.trim()) return;
  const configuredId = stringValue(record[secretIdKey]);
  try {
    store.setSecret(configuredId || defaultSecretId, value.trim());
  } catch {
    // A malformed persisted secret id must not block startup; fall back to the
    // stable default id so the secret is still preserved.
    store.setSecret(defaultSecretId, value.trim());
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
