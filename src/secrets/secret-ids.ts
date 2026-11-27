import { sha256Hex } from "../utils/sha256";

/**
 * Secret-id shapes with no settings imports. `secret-store.ts` owns reading
 * and writing the store; `mcp/settings.ts` and `settings-schema.ts` only need
 * the ids, so they import this module instead of the store. That keeps the
 * MCP and settings layers out of a circle with the store (#438).
 */

export const OPENROUTER_API_KEY_SECRET_ID = "agentic-chat-openrouter-api-key";
export const OPENAI_COMPATIBLE_API_KEY_SECRET_ID = "agentic-chat-openai-compatible-api-key";
export const WEB_SEARCH_API_KEY_SECRET_ID = "agentic-chat-web-search-api-key";

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

export function mcpSecretId(serverId: string, kind: string): string {
  return normalizeSecretId(`agentic-chat-mcp-${serverId}-${kind}`);
}

type McpSecretSlot = {
  /** `server` is the MCP record itself; `oauth` is its `oauth` member. */
  readonly scope: "server" | "oauth";
  readonly valueKey: string;
  readonly secretIdKey: string;
  readonly secretKind: string;
};

/** Every secret-backed MCP field, for hydration, storage, and legacy migration. */
export const MCP_SECRET_SLOTS: readonly McpSecretSlot[] = [
  {
    scope: "server",
    valueKey: "authHeaderValue",
    secretIdKey: "authHeaderValueSecretId",
    secretKind: "auth-header-value",
  },
  {
    scope: "oauth",
    valueKey: "clientSecret",
    secretIdKey: "clientSecretSecretId",
    secretKind: "oauth-client-secret",
  },
  {
    scope: "oauth",
    valueKey: "accessToken",
    secretIdKey: "accessTokenSecretId",
    secretKind: "oauth-access-token",
  },
  {
    scope: "oauth",
    valueKey: "refreshToken",
    secretIdKey: "refreshTokenSecretId",
    secretKind: "oauth-refresh-token",
  },
];

/** Fill the missing secret ids of one scope of an MCP record. */
export function ensureMcpScopeRefs(serverId: string, record: object, scope: McpSecretSlot["scope"]): void {
  const target = record as Record<string, string>;
  for (const slot of MCP_SECRET_SLOTS) {
    if (slot.scope !== scope) continue;
    target[slot.secretIdKey] ||= mcpSecretId(serverId, slot.secretKind);
  }
}
