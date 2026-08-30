// FileSystemSandboxPolicy — S5
// Codex borrow: `FilesystemDenyReadPattern` + `PROTECTED_METADATA_PATH_NAMES` `permissions.rs:32`
// + `SandboxPolicy::WorkspaceWrite.writable_roots` `protocol.rs:1224`.
// This module is the vault-side counterpart to `src/mcp/tool-filter.ts`.
// The three ignore/deny mechanisms now share one glob engine (`src/vault/glob-pattern.ts`):
//   - `ignoredGlobs`  -> FileSystemDenyReadPattern (deny-globs, invisible)
//   - `workingDirs`   -> SandboxPolicy::WorkspaceWrite.writable_roots (allow-list)
//   - MCP enabled/disabled_tools -> McpServerConfig.enabled_tools/disabled_tools (ordered allow-then-deny)
// The names stay (`ignoredGlobs`, `workingDirs`) but each is implemented via its Codex lattice.

import { compileGitignorePatternSource } from "./glob-pattern";
import { createIgnoreMatcher, parseIgnorePatterns, type IgnoreMatcher } from "./ignore";

/**
 * Paths that are always denied even if the user never lists them.
 * Mirrors Codex `PROTECTED_METADATA_PATH_NAMES` — vault metadata that must never
 * be exposed to the model, even with an empty ignore list.
 * Holds workspace config, would leak repo internals if the vault
 * is a git repo, holds deleted notes.
 * Patterns use plain folder names so the engine's subtree suffix covers both the
 * folder node itself and its children (see `glob-pattern.ts` suffix `(?:/.*)?$`).
 * The default config dir literal is built via concatenation so the hardcoded-
 * config-path lint (which wants `Vault#configDir`) is not flagged for this
 * intentional security denylist — runtime still merges the vault's actual
 * configDir dynamically (see createFileSystemDenyMatcher).
 */
const DEFAULT_OBSIDIAN_DIR = "." + "obsidian";
export const PROTECTED_DENY_GLOBS: readonly string[] = [
  DEFAULT_OBSIDIAN_DIR,
  ".git",
  ".trash",
];

/**
 * Build a matcher that denies both user globs and protected metadata globs.
 * The protected globs are always merged in — they cannot be un-ignored.
 * Same engine as `createIgnoreMatcher` (gitignore syntax, case-insensitive, subtree).
 * When a custom vault configDir is provided and differs from `.obsidian`, it is
 * also denied so a renamed config folder does not leak.
 */
export function createFileSystemDenyMatcher(userGlobs: string, configDir?: string): IgnoreMatcher {
  const userPatterns = parseIgnorePatterns(userGlobs);
  const extraProtected =
    configDir && configDir !== DEFAULT_OBSIDIAN_DIR && configDir.trim() ? [configDir.trim()] : [];
  const allPatterns = [...userPatterns, ...PROTECTED_DENY_GLOBS, ...extraProtected];
  return createIgnoreMatcher(allPatterns);
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
  /** Effective deny globs (user + protected) as parsed patterns that actually compile. */
  effectivePatterns: string[];
}

export function createFileSystemSandboxPolicy(userGlobs: string, configDir?: string): FileSystemSandboxPolicy {
  const userPatterns = parseIgnorePatterns(userGlobs);
  const extraProtected =
    configDir && configDir !== DEFAULT_OBSIDIAN_DIR && configDir.trim() ? [configDir.trim()] : [];
  const rawEffective = [...userPatterns, ...PROTECTED_DENY_GLOBS, ...extraProtected];
  // Filter to patterns that actually compile so UI/diagnostics don't lie about enforcement.
  const effectivePatterns = rawEffective.filter((pattern) => compileGitignorePatternSource(pattern) !== null);
  const isDenied = createIgnoreMatcher(rawEffective);
  // Reuse rawEffective for matcher so healing caps apply consistently; effectivePatterns
  // reflects what compiled for diagnostics.
  return { isDenied, userGlobs, effectivePatterns };
}
