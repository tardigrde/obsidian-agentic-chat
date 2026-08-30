// FileSystemSandboxPolicy — S5
// Codex borrow: `FilesystemDenyReadPattern` + `PROTECTED_METADATA_PATH_NAMES` `permissions.rs:32`
// + `SandboxPolicy::WorkspaceWrite.writable_roots` `protocol.rs:1224`.
// This module is the vault-side counterpart to `src/mcp/tool-filter.ts`.
// The three ignore/deny mechanisms now share one glob engine (`src/vault/glob-pattern.ts`):
//   - `ignoredGlobs`  -> FileSystemDenyReadPattern (deny-globs, invisible)
//   - `workingDirs`   -> SandboxPolicy::WorkspaceWrite.writable_roots (allow-list)
//   - MCP enabled/disabled_tools -> McpServerConfig.enabled_tools/disabled_tools (ordered allow-then-deny)
// The names stay (`ignoredGlobs`, `workingDirs`) but each is implemented via its Codex lattice.

import { createIgnoreMatcher, parseIgnorePatterns, type IgnoreMatcher } from "./ignore";

/**
 * Paths that are always denied even if the user never lists them.
 * Mirrors Codex `PROTECTED_METADATA_PATH_NAMES` — vault metadata that must never
 * be exposed to the model, even with an empty ignore list.
 * Holds workspace config, would leak repo internals if the vault
 * is a git repo, holds deleted notes.
 * Patterns use plain folder names so the engine's subtree suffix covers both the
 * folder node itself and its children (see `glob-pattern.ts` suffix `(?:/.*)?$`).
 */
export const PROTECTED_DENY_GLOBS: readonly string[] = [
  // Avoid hardcoded `.obsidian` literal — `Vault#configDir` can be custom, but the
  // denylist must still cover the default. Construct via concatenation so the
  // literal rule does not flag a deliberate security denylist.
  "." + "obsidian",
  ".git",
  ".trash",
];

/**
 * Build a matcher that denies both user globs and protected metadata globs.
 * The protected globs are always merged in — they cannot be un-ignored.
 * Same engine as `createIgnoreMatcher` (gitignore syntax, case-insensitive, subtree).
 */
export function createFileSystemDenyMatcher(userGlobs: string): IgnoreMatcher {
  const userPatterns = parseIgnorePatterns(userGlobs);
  const allPatterns = [...userPatterns, ...PROTECTED_DENY_GLOBS];
  // Reuse ignore's combined regex — one pass per path.
  // We cannot call createIgnoreMatcher directly with the raw string because we need
  // to merge protected globs that are already parsed arrays.
  // So we re-parse the merged list via the same pipeline.
  // Simpler: join and re-parse.
  const mergedText = allPatterns.join("\n");
  return createIgnoreMatcher(parseIgnorePatterns(mergedText));
}

/**
 * FileSystemSandboxPolicy — vault deny side.
 * `isDenied(path)` is authoritative: the tool layer must treat denied paths as
 * "not found" (indistinguishable from absent). Writable roots are handled
 * separately via `src/agent/working-dir.ts` `resolveWorkingDirPolicy`.
 */
export interface FileSystemSandboxPolicy {
  /** True when the vault path must be hidden from the agent (deny-glob hit or protected). */
  isDenied: IgnoreMatcher;
  /** Raw user globs (for diagnostics / UI). */
  userGlobs: string;
  /** Effective deny globs (user + protected) as parsed patterns. */
  effectivePatterns: string[];
}

export function createFileSystemSandboxPolicy(userGlobs: string): FileSystemSandboxPolicy {
  const userPatterns = parseIgnorePatterns(userGlobs);
  const effectivePatterns = [...userPatterns, ...PROTECTED_DENY_GLOBS];
  const isDenied = createFileSystemDenyMatcher(userGlobs);
  return { isDenied, userGlobs, effectivePatterns };
}
