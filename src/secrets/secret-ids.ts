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
