// Ignore lists: vault-relative globs the agent may never read or even see.
// S5: FileSystemSandboxPolicy deny-globs — `FilesystemDenyReadPattern` `permissions.rs:32`
// (same engine as MCP enabled/disabled_tools and writable_roots, see `glob-pattern.ts`).
// Enforced at the tool layer (see src/tools/vault-tools.ts) so the model cannot
// route around them. Excluded paths are made invisible, not merely denied.

import { compileGitignorePatternSource } from "./glob-pattern";

export type IgnoreMatcher = (path: string) => boolean;

export const MAX_VAULT_IGNORE_PATTERNS = 200;
export const MAX_VAULT_IGNORE_LENGTH = 200;

/** Split a newline-delimited setting into patterns, dropping blanks and `#` comments. */
export function parseIgnorePatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.normalize("NFC").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Build a matcher for vault-relative paths from gitignore-style patterns.
 * Matching is case-insensitive (a security feature should over-block rather
 * than let `Secret.md` slip past `secret.md`). Both patterns and subject paths
 * are NFC-normalized before testing so files stored as NFD on macOS (APFS) still
 * match patterns typed as NFC (adversarial-review finding).
 *
 * Supported syntax:
 * - `*`  matches any run of characters except `/`
 * - `**` matches across directory separators
 * - `?`  matches a single character except `/`
 * - a leading `/` anchors the pattern to the vault root
 * - a pattern containing a `/` is anchored to the vault root; otherwise it
 *   matches at any depth (by basename), like gitignore
 * - any match also covers the path's subtree, so a folder pattern hides the
 *   files inside it; a trailing `/` is therefore optional/documentary
 *
 * A pattern whose double-star segments exceed the shared glob cap
 * (`MAX_DOUBLE_STAR_SEGMENTS` in glob-pattern.ts) is skipped. A skipped **deny**
 * pattern never matches, so the intended hidden path stays visible (fail-open) —
 * use a single `**` for deep traversal instead; a skipped allow pattern would be
 * fail-closed.
 */
export function createIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  // Heal vault globs the same way MCP globs are healed: cap count/length,
  // NFC-normalize, drop empties/comments, dedupe case-insensitively.
  const seen = new Set<string>();
  const healed: string[] = [];
  for (const raw of patterns) {
    const trimmed = raw.normalize("NFC").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.length > MAX_VAULT_IGNORE_LENGTH) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    healed.push(trimmed);
    if (healed.length >= MAX_VAULT_IGNORE_PATTERNS) break;
  }
  const sources = healed
    .map(compileGitignorePatternSource)
    .filter((source): source is string => source !== null);
  if (sources.length === 0) return () => false;
  // One combined regex = a single pass per path, instead of one test per pattern.
  // Guard against engine limits on huge patterns (fail-closed: test sequentially).
  let combined: RegExp | null = null;
  try {
    combined = new RegExp(sources.map((source) => `(?:${source})`).join("|"), "iu");
  } catch {
    combined = null;
  }
  if (combined) {
    return (path) => combined.test(canonicalizeVaultPathForIgnore(path));
  }
  // Fallback: compile each source individually and test sequentially if combined is too large.
  const singles = sources.map((source) => {
    try {
      return new RegExp(source, "iu");
    } catch {
      return null;
    }
  }).filter((re): re is RegExp => re !== null);
  if (singles.length === 0) return () => false;
  return (path) => {
    const normalized = canonicalizeVaultPathForIgnore(path);
    return singles.some((re) => re.test(normalized));
  };
}

function canonicalizeVaultPathForIgnore(path: string): string {
  // Defense-in-depth: callers should already normalize via normalizeVaultPath,
  // but the matcher is also used via runtime-resource-state & lexical paths.
  // Canonicalize slashes, collapse `.` segments, strip leading `/`, NFC-normalize.
  const withForwardSlashes = path.replaceAll("\\", "/");
  const segments: string[] = [];
  for (const segment of withForwardSlashes.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") continue;
    segments.push(segment);
  }
  return segments.join("/").normalize("NFC");
}
