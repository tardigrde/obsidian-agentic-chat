// Ignore lists: vault-relative globs the agent may never read or even see.
// Enforced at the tool layer (see src/tools/vault-tools.ts) so the model cannot
// route around them. Excluded paths are made invisible, not merely denied.

import { compileGitignorePatternSource } from "./glob-pattern";

export type IgnoreMatcher = (path: string) => boolean;

/** Split a newline-delimited setting into patterns, dropping blanks and `#` comments. */
export function parseIgnorePatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Build a matcher for vault-relative paths from gitignore-style patterns.
 * Matching is case-insensitive (a security feature should over-block rather
 * than let `Secret.md` slip past `secret.md`).
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
 */
export function createIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  const sources = patterns
    .map(compileGitignorePatternSource)
    .filter((source): source is string => source !== null);
  if (sources.length === 0) return () => false;
  // One combined regex = a single pass per path, instead of one test per pattern.
  const combined = new RegExp(sources.map((source) => `(?:${source})`).join("|"), "i");
  return (path) => combined.test(path.replace(/^\/+/, ""));
}
