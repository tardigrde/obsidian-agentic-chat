// MCP tool filtering — S5 FileSystemSandbox split.
// Codex borrow: `McpServerConfig.enabled_tools/disabled_tools` `mcp_types.rs:233`
// ordered allow-then-deny like `FilesystemDenyReadPattern`.
// Same glob engine as vault ignore (`src/vault/glob-pattern.ts`) so the three
// ignore/deny mechanisms share one dialect.

import { globToRegExpSource } from "../vault/glob-pattern";

export const MAX_MCP_TOOL_GLOB_PATTERNS = 100;
export const MAX_MCP_TOOL_GLOB_LENGTH = 200;

/**
 * Heal a raw enabled/disabled_tools value into a string[].
 * Accepts array, comma/newline string, or legacy mixed — drops blanks/comments,
 * trims, dedupes case-insensitively by lowercased value, caps count/length.
 */
export function healMcpToolGlobs(value: unknown): string[] {
  let raw: unknown[];
  if (Array.isArray(value)) raw = value;
  else if (typeof value === "string") {
    // Support legacy comma or newline separated strings
    raw = value.split(/[\n,]/);
  } else {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    // Drop comment lines like ignore patterns do
    if (trimmed.startsWith("#")) continue;
    if (trimmed.length > MAX_MCP_TOOL_GLOB_LENGTH) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_MCP_TOOL_GLOB_PATTERNS) break;
  }
  return out;
}

/**
 * Compile a single tool glob to a case-insensitive RegExp matching the whole name.
 * Uses shared `globToRegExpSource` so the single-star, double-star and question-mark
 * globs behave like vault ignore (`*` matches any run except `/`, `**` matches any
 * including `/`, `?` matches one char except `/`).
 * Trailing `/` is stripped (documentary); leading `/` is stripped (tool names have no root).
 * `globToRegExpSource` can reject unsafe patterns (excessive double-star segments — a
 * ReDoS guard), in which case this returns null and the pattern is skipped
 * (fail-open for deny: a rejected deny glob never matches, so the intended
 * hidden tool stays visible — surface a warning in the UI; fail-closed for allow).
 */
function toolGlobToRegExp(pattern: string): RegExp | null {
  let body = pattern.normalize("NFC").trim();
  if (!body) return null;
  if (body.endsWith("/")) body = body.slice(0, -1);
  if (body.startsWith("/")) body = body.slice(1);
  if (!body) return null;
  try {
    const source = globToRegExpSource(body);
    if (source === null) return null;
    return new RegExp(`^${source}$`, "iu");
  } catch {
    return null;
  }
}

/**
 * Create a matcher for tool names from glob patterns.
 * Empty list => no match (caller decides allow-all vs deny-none).
 */
export function createToolGlobMatcher(patterns: string[]): (name: string) => boolean {
  const regexes = healMcpToolGlobs(patterns)
    .map(toolGlobToRegExp)
    .filter((r): r is RegExp => r !== null);
  if (regexes.length === 0) return () => false;
  return (name: string) => {
    const normalized = name.normalize("NFC").trim();
    return regexes.some((re) => re.test(normalized));
  };
}

/**
 * Filter MCP tools by ordered allow-then-deny globs (Codex semantics).
 * - `enabledTools` allowlist: when non-empty, only tools matching at least one
 *   enabled glob survive the allow phase. Empty => allow all.
 * - `disabledTools` denylist: any tool matching a disabled glob is removed,
 *   even if it was allowed. Deny wins.
 * Tool names are matched as strings and never assigned back into any object, so
 * prototype-key names (`__proto__`, `constructor`) are compared safely.
 */
export function filterMcpToolsByGlobs<T extends { name: string }>(
  tools: T[],
  enabledTools: string[],
  disabledTools: string[],
): T[] {
  const enabled = healMcpToolGlobs(enabledTools);
  const disabled = healMcpToolGlobs(disabledTools);

  let allowed: T[];
  if (enabled.length === 0) {
    allowed = [...tools];
  } else {
    const isEnabled = createToolGlobMatcher(enabled);
    allowed = tools.filter((tool) => isEnabled(tool.name));
  }

  if (disabled.length === 0) return allowed;

  const isDisabled = createToolGlobMatcher(disabled);
  return allowed.filter((tool) => !isDisabled(tool.name));
}
