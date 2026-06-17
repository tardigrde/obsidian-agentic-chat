import type { ApprovalPolicy } from "./approval";
import { normalizeFolderPath, normalizeVaultPath } from "../vault/path";

/**
 * Working-directory scope (C1/S2). A granted folder becomes a working set: tool
 * calls whose targets sit **inside** any granted dir auto-run, while calls that
 * reach **outside** every granted dir route through the approval gate (ask) — even
 * read-only ones. The inverse of ignore-globs (an allow-list working set vs a
 * deny-list). Empty config = today's behavior. Pure, so the gate stays testable.
 */

/** Tool arg fields that name a vault path the call acts on. */
const PATH_FIELDS = ["path", "newPath"] as const;

/**
 * The vault-relative target paths a tool call acts on, normalized. Pathless calls
 * (find, grep without a path, get_active_note) return `[]` and so are unaffected by
 * the boundary. Invalid/escaping paths are dropped — the tool layer rejects them.
 */
export function toolTargetPaths(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const paths: string[] = [];
  for (const field of PATH_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") continue;
    try {
      paths.push(normalizeVaultPath(value));
    } catch {
      // An invalid/escaping path can never be "inside" a granted dir; ignore it here.
    }
  }
  return paths;
}

/** Normalize granted dirs once: drop blanks/invalid entries and de-duplicate. */
export function normalizeWorkingDirs(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    try {
      const normalized = normalizeFolderPath(dir);
      if (!out.includes(normalized)) out.push(normalized);
    } catch {
      // Skip a malformed entry rather than throwing inside the gate.
    }
  }
  return out;
}

/** True when `path` is at or under one of the granted dirs. The root ("") matches all. */
export function isInsideWorkingDirs(path: string, dirs: string[]): boolean {
  return dirs.some((dir) => dir === "" || path === dir || path.startsWith(`${dir}/`));
}

/**
 * Refine an approval policy by the working-dir boundary. With dirs configured, a call
 * whose targets are all inside a granted dir auto-runs (`allow`); a call with any
 * target outside routes through `ask`; pathless calls and an empty config are returned
 * unchanged. A `deny` (per-tool override / plan mode) always wins.
 */
export function resolveWorkingDirPolicy(
  workingDirs: string[],
  args: unknown,
  basePolicy: ApprovalPolicy,
): ApprovalPolicy {
  if (basePolicy === "deny") return "deny";
  const dirs = normalizeWorkingDirs(workingDirs);
  if (dirs.length === 0) return basePolicy;
  const targets = toolTargetPaths(args);
  if (targets.length === 0) return basePolicy;
  const allInside = targets.every((path) => isInsideWorkingDirs(path, dirs));
  return allInside ? "allow" : "ask";
}
