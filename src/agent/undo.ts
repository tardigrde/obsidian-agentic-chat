import { type App, TFile, TFolder, type TAbstractFile } from "obsidian";
import { normalizeVaultPath } from "../vault/path";
import { fnv1a32 } from "../utils/hash";
import { ensureVaultFolder, ensureVaultParentFolder } from "../vault/storage";
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
  return fnv1a32(body, { codePoints: true }).toString(36);
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
    const path = stringPath(raw.path);
    if (toolName === "rename") return renameEntry(path, raw.newPath);
    if (!path) return null;
    const entry = app.vault.getAbstractFileByPath(path);
    const content = await readExistingContent(app, path, entry);
    if (toolName === "write") return contentEntry(path, content);
    if (toolName === "edit" || toolName === "set_properties") return editableContentEntry(path, content);
    if (toolName === "delete") return deleteEntry(app, path, entry, content);
    return null;
  } catch {
    return null;
  }
}

function stringPath(value: unknown): string {
  return typeof value === "string" ? normalizeVaultPath(value) : "";
}

function renameEntry(from: string, newPath: unknown): UndoEntry | null {
  const to = stringPath(newPath);
  return from && to ? { kind: "rename", from, to } : null;
}

/** Read a file body from the vault index, falling back to a direct disk read. */
async function readExistingContent(app: App, path: string, entry: TAbstractFile | null): Promise<string | null> {
  const content = entry instanceof TFile ? await app.vault.cachedRead(entry) : null;
  if (content !== null) return content;
  // Stale tree: dot-folder files on disk but missing from the vault index.
  try {
    return await app.vault.adapter.read(path);
  } catch {
    // Not a readable file on disk; delete falls through to folder checks.
    return null;
  }
}

function contentEntry(path: string, content: string | null): UndoEntry {
  return {
    kind: "content",
    path,
    before: content,
    beforeSummary: content === null ? undefined : summarizeFileBody(content),
  };
}

function editableContentEntry(path: string, content: string | null): UndoEntry | null {
  // edit/frontmatter need the file to have existed; nothing to restore otherwise.
  if (content === null) return null;
  return { kind: "content", path, before: content, beforeSummary: summarizeFileBody(content) };
}

async function deleteEntry(
  app: App,
  path: string,
  entry: TAbstractFile | null,
  content: string | null,
): Promise<UndoEntry | null> {
  if (content !== null) return { kind: "delete", path, before: content, beforeSummary: summarizeFileBody(content) };
  if (entry instanceof TFolder && entry.children.length === 0) return { kind: "delete_folder", path };
  if (entry instanceof TFolder) return null;
  // Stale-tree empty folder: confirm on disk so /undo can restore it.
  if (await isEmptyFolderOnDisk(app, path)) return { kind: "delete_folder", path };
  return null;
}

async function isEmptyFolderOnDisk(app: App, path: string): Promise<boolean> {
  try {
    const listing = await app.vault.adapter.list(path);
    return (listing?.folders?.length ?? 0) + (listing?.files?.length ?? 0) === 0;
  } catch {
    // Not a folder on disk; nothing undoable.
    return false;
  }
}

/** Revert a captured change. Returns a human summary; throws if the revert can't be applied. */
export async function applyUndo(app: App, entry: UndoEntry): Promise<string> {
  if (entry.kind === "rename") return applyRenameUndo(app, entry);
  if (entry.kind === "delete") return applyDeleteUndo(app, entry);
  if (entry.kind === "delete_folder") return applyDeleteFolderUndo(app, entry);
  return applyContentUndo(app, entry);
}

async function applyRenameUndo(app: App, entry: Extract<UndoEntry, { kind: "rename" }>): Promise<string> {
  const file = app.vault.getAbstractFileByPath(entry.to);
  if (!(file instanceof TFile)) throw new Error(`${entry.to} no longer exists.`);
  await app.fileManager.renameFile(file, entry.from);
  return `Renamed ${entry.to} back to ${entry.from}.`;
}

async function applyDeleteUndo(app: App, entry: Extract<UndoEntry, { kind: "delete" }>): Promise<string> {
  await ensureVaultParentFolder(app, entry.path);
  await app.vault.create(entry.path, entry.before);
  return `Restored ${entry.path}.`;
}

async function applyDeleteFolderUndo(app: App, entry: Extract<UndoEntry, { kind: "delete_folder" }>): Promise<string> {
  // A concurrent undo of the same folder is absorbed as already restored.
  await ensureVaultFolder(app, entry.path);
  return `Restored folder ${entry.path}.`;
}

async function applyContentUndo(app: App, entry: Extract<UndoEntry, { kind: "content" }>): Promise<string> {
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
    await ensureVaultParentFolder(app, entry.path);
    await app.vault.create(entry.path, entry.before);
  }
  return `Reverted ${entry.path}.`;
}
