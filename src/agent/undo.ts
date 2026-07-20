import { type App, TFile, TFolder } from "obsidian";
import { getParentPath, normalizeVaultPath } from "../vault/path";
export { UNDOABLE_TOOLS } from "../tools/tool-contracts";

/** Compact fingerprint of a file body for log slimming. The hash is FNV-1a —
 * not cryptographic, just stable + fast + sync — so it's safe to import in
 * mobile and runs in the edit path without blocking. */
export interface FileBodySummary {
  hash: string;
  length: number;
}

/** A reversible record of one mutating vault tool call. `beforeSummary` is
 * the slim shadow persisted to the session log; the in-memory `before` body
 * is always set (used by `/undo`). The session-manager drops `before` from
 * non-first checkpoints before writing to JSONL. */
export type UndoEntry =
  | { kind: "content"; path: string; before: string | null; beforeSummary?: FileBodySummary }
  | { kind: "rename"; from: string; to: string }
  | { kind: "delete"; path: string; before: string; beforeSummary?: FileBodySummary }
  | { kind: "delete_folder"; path: string };

/** FNV-1a 32-bit hash, base-36. Used as a stable fingerprint for file
 * bodies; collision risk is acceptable for log-slimming diff detection. */
function fnv1a(body: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.codePointAt(i)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Compute a body summary (hash + length) for log storage. */
export function summarizeFileBody(body: string): FileBodySummary {
  return { hash: fnv1a(body), length: body.length };
}

/**
 * Capture the inverse of a mutating tool call *before* it runs. Best-effort:
 * returns null on any failure (e.g. a stub app in tests), so undo capture can
 * never break a tool call.
 */
export async function captureUndo(app: App, toolName: string, args: unknown): Promise<UndoEntry | null> {
  try {
    const raw = (args ?? {}) as { path?: unknown; newPath?: unknown };
    const path = typeof raw.path === "string" ? normalizeVaultPath(raw.path) : "";
    if (toolName === "rename") {
      const to = typeof raw.newPath === "string" ? normalizeVaultPath(raw.newPath) : "";
      return path && to ? { kind: "rename", from: path, to } : null;
    }
    if (!path) return null;
    const entry = app.vault.getAbstractFileByPath(path);
    const content = entry instanceof TFile ? await app.vault.cachedRead(entry) : null;
    if (toolName === "write") {
      return {
        kind: "content",
        path,
        before: content,
        beforeSummary: content === null ? undefined : summarizeFileBody(content),
      };
    }
    // edit/frontmatter need the file to have existed; nothing to restore otherwise.
    if ((toolName === "edit" || toolName === "set_properties") && content === null) return null;
    if (toolName === "edit" || toolName === "set_properties") {
      // Narrowed by the early-return above; `?? ""` is just a type-guard, never triggers.
      return { kind: "content", path, before: content, beforeSummary: summarizeFileBody(content ?? "") };
    }
    if (toolName === "delete") {
      if (content !== null) return { kind: "delete", path, before: content, beforeSummary: summarizeFileBody(content) };
      if (entry instanceof TFolder && entry.children.length === 0) return { kind: "delete_folder", path };
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Revert a captured change. Returns a human summary; throws if the revert can't be applied. */
export async function applyUndo(app: App, entry: UndoEntry): Promise<string> {
  if (entry.kind === "rename") {
    const file = app.vault.getAbstractFileByPath(entry.to);
    if (!(file instanceof TFile)) throw new Error(`${entry.to} no longer exists.`);
    await app.fileManager.renameFile(file, entry.from);
    return `Renamed ${entry.to} back to ${entry.from}.`;
  }
  if (entry.kind === "delete") {
    await ensureParentFolders(app, entry.path);
    await app.vault.create(entry.path, entry.before);
    return `Restored ${entry.path}.`;
  }
  if (entry.kind === "delete_folder") {
    await ensureParentFolders(app, entry.path);
    if (!app.vault.getFolderByPath(entry.path)) await app.vault.createFolder(entry.path);
    return `Restored folder ${entry.path}.`;
  }
  const existing = app.vault.getAbstractFileByPath(entry.path);
  if (entry.before === null) {
    if (existing instanceof TFile) {
      await app.fileManager.trashFile(existing);
      return `Removed ${entry.path} (it didn't exist before).`;
    }
    return `Nothing to undo for ${entry.path}.`;
  }
  if (existing instanceof TFile) {
    await app.vault.process(existing, () => entry.before ?? "");
  } else {
    await ensureParentFolders(app, entry.path);
    await app.vault.create(entry.path, entry.before);
  }
  return `Reverted ${entry.path}.`;
}

/** One-line description of what undoing an entry will do. */
export function describeUndo(entry: UndoEntry): string {
  if (entry.kind === "rename") return `rename ${entry.to} → ${entry.from}`;
  if (entry.kind === "delete") return `restore ${entry.path}`;
  if (entry.kind === "delete_folder") return `restore folder ${entry.path}`;
  return entry.before === null ? `remove ${entry.path}` : `revert ${entry.path}`;
}

async function ensureParentFolders(app: App, path: string): Promise<void> {
  const parent = getParentPath(path);
  if (!parent) return;
  let current = "";
  // Drop empty segments (leading/trailing/consecutive slashes) so we never try
  // to create a folder with an empty name.
  for (const segment of parent.split("/").filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    if (!app.vault.getFolderByPath(current)) await app.vault.createFolder(current);
  }
}
