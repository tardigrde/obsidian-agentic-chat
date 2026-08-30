// Ignore lists: vault-relative globs the agent may never read or even see.
// S5: FileSystemSandboxPolicy deny-globs — `FilesystemDenyReadPattern` `permissions.rs:32`
// (same engine as MCP enabled/disabled_tools and writable_roots, see `glob-pattern.ts`).
// Enforced at the tool layer (see src/tools/vault-tools.ts) so the model cannot
// route around them. Excluded paths are made invisible, not merely denied.

import { compileGitignorePatternSource } from "./glob-pattern";

export type IgnoreMatcher = (path: string) => boolean;

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
 * (`MAX_DOUBLE_STAR_SEGMENTS` in glob-pattern.ts) is skipped. Skipped deny
 * patterns never match, so they can never re-allow a hidden path (fail-closed).
 */
export function createIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  const sources = patterns
    .map(compileGitignorePatternSource)
    .filter((source): source is string => source !== null);
  if (sources.length === 0) return () => false;
  // One combined regex = a single pass per path, instead of one test per pattern.
  const combined = new RegExp(sources.map((source) => `(?:${source})`).join("|"), "iu");
  return (path) => combined.test(path.replace(/^\/+/, "").normalize("NFC"));
}
