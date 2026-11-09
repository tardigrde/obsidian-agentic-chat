import {
  OBSERVABILITY_AUTH_HEADER_VALUE_SECRET_ID,
  OBSERVABILITY_LANGFUSE_PUBLIC_KEY_SECRET_ID,
  OBSERVABILITY_LANGFUSE_SECRET_KEY_SECRET_ID,
} from "../observability/settings";
import {
  mcpSecretId,
  normalizeSecretId,
  OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
  OPENROUTER_API_KEY_SECRET_ID,
  WEB_SEARCH_API_KEY_SECRET_ID,
  type SecretStore,
} from "./secret-store";

/** A legacy plaintext secret the store refused; held in memory for this session only. */
export interface LegacySecretMigrationFailure {
  readonly secretId: string;
  readonly value: string;
  readonly error: unknown;
}

type TakeSecret = (
  record: Record<string, unknown>,
  valueKey: string,
  secretIdKey: string,
  defaultSecretId: string,
) => void;

/**
 * One-time migration of the plaintext secret keys that pre-secretStorage
 * data.json files carried. The legacy keys are read once, written to the
 * secret store, and then deleted from the raw stored object before
 * `mergeSettings` runs. No deprecated plaintext field is part of the public
 * settings surface; runtime settings only hold an in-memory secret cache that
 * `hydrateSettingsSecrets` fills from the store.
 *
 * The migration is idempotent: a second load has no legacy keys to move.
 * A value already in the store wins over the legacy plaintext, so a stale
 * synced data.json cannot clobber a rotated key.
 *
 * Never throws: a value the store refuses is returned as a failure. The caller
 * keeps it in memory for this session through {@link withUnmigratedSecrets};
 * the plaintext key is still deleted, so it is never written back to data.json.
 */
export function migrateLegacyPlaintextSecrets(stored: unknown, store: SecretStore): LegacySecretMigrationFailure[] {
  const failures: LegacySecretMigrationFailure[] = [];
  const root = asRecord(stored);
  if (!root) return failures;
  const takeSecret: TakeSecret = (record, valueKey, secretIdKey, defaultSecretId) =>
    takeSecretInto(record, valueKey, secretIdKey, defaultSecretId, store, failures);

  takeSecret(root, "openrouterApiKey", "openrouterApiKeySecretId", OPENROUTER_API_KEY_SECRET_ID);
  takeSecret(root, "openaiCompatibleApiKey", "openaiCompatibleApiKeySecretId", OPENAI_COMPATIBLE_API_KEY_SECRET_ID);

  const web = asRecord(root.web);
  if (web) takeSecret(web, "searchApiKey", "searchApiKeySecretId", WEB_SEARCH_API_KEY_SECRET_ID);

  const observability = asRecord(root.observability);
  if (observability) {
    takeSecret(
      observability,
      "langfusePublicKey",
      "langfusePublicKeySecretId",
      OBSERVABILITY_LANGFUSE_PUBLIC_KEY_SECRET_ID,
    );
    takeSecret(
      observability,
      "langfuseSecretKey",
      "langfuseSecretKeySecretId",
      OBSERVABILITY_LANGFUSE_SECRET_KEY_SECRET_ID,
    );
    takeSecret(observability, "authHeaderValue", "authHeaderValueSecretId", OBSERVABILITY_AUTH_HEADER_VALUE_SECRET_ID);
  }

  // Id-less servers get a distinct index-based fallback so their secrets do
  // not overwrite each other; takeSecret records the id it used on the server.
  asArray(asRecord(root.mcp)?.servers).forEach((rawServer, index) => {
    const server = asRecord(rawServer);
    if (server) migrateMcpRecord(server, stringValue(server.id) || `server-${index}`, takeSecret);
  });

  const mcpState = asRecord(asRecord(root.plugins)?.mcpState);
  for (const [id, rawState] of Object.entries(mcpState ?? {})) {
    const state = asRecord(rawState);
    if (state) migrateMcpRecord(state, id || "server", takeSecret);
  }
  return failures;
}

/**
 * Read-through overlay for hydration: serves values the migration could not
 * write to the store, for this session only. Writes go to the underlying store.
 */
export function withUnmigratedSecrets(
  store: SecretStore,
  failures: readonly LegacySecretMigrationFailure[],
): SecretStore {
  if (failures.length === 0) return store;
  const pending = new Map(failures.map((failure) => [normalizeSecretId(failure.secretId), failure.value]));
  return {
    getSecret: (id) => store.getSecret(id) || pending.get(normalizeSecretId(id)) || "",
    setSecret: (id, value) => store.setSecret(id, value),
  };
}

function migrateMcpRecord(record: Record<string, unknown>, serverId: string, takeSecret: TakeSecret): void {
  takeSecret(record, "authHeaderValue", "authHeaderValueSecretId", mcpSecretId(serverId, "auth-header-value"));
  const oauth = asRecord(record.oauth);
  if (!oauth) return;
  takeSecret(oauth, "clientSecret", "clientSecretSecretId", mcpSecretId(serverId, "oauth-client-secret"));
  takeSecret(oauth, "accessToken", "accessTokenSecretId", mcpSecretId(serverId, "oauth-access-token"));
  takeSecret(oauth, "refreshToken", "refreshTokenSecretId", mcpSecretId(serverId, "oauth-refresh-token"));
}

/**
 * Read and remove one legacy plaintext value, moving it to the secret store
 * when non-empty. The record's secret-id field ends up naming the id the
 * value lives under, so hydration finds it.
 */
function takeSecretInto(
  record: Record<string, unknown>,
  valueKey: string,
  secretIdKey: string,
  defaultSecretId: string,
  store: SecretStore,
  failures: LegacySecretMigrationFailure[],
): void {
  const value = record[valueKey];
  delete record[valueKey];
  if (typeof value !== "string" || !value.trim()) return;
  const secret = value.trim();
  const configuredId = stringValue(record[secretIdKey]);
  if (configuredId) {
    try {
      keepSecret(store, configuredId, secret);
      return;
    } catch {
      // A malformed persisted secret id must not block startup; fall back to
      // the stable default id below and repoint the record at it.
    }
  }
  record[secretIdKey] = defaultSecretId;
  try {
    keepSecret(store, defaultSecretId, secret);
  } catch (error) {
    failures.push({ secretId: defaultSecretId, value: secret, error });
  }
}

/** Write the legacy value only when the store has none: an existing (possibly rotated) value wins. */
function keepSecret(store: SecretStore, id: string, value: string): void {
  if (store.getSecret(id).trim()) return;
  store.setSecret(id, value);
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
