import { type App, TFile, TFolder, type TAbstractFile } from "obsidian";
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
  for (const char of body) {
    hash ^= char.codePointAt(0) ?? 0;
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
  await ensureParentFolders(app, entry.path);
  await app.vault.create(entry.path, entry.before);
  return `Restored ${entry.path}.`;
}

async function applyDeleteFolderUndo(app: App, entry: Extract<UndoEntry, { kind: "delete_folder" }>): Promise<string> {
  await ensureParentFolders(app, entry.path);
  if (!(await folderExists(app, entry.path))) {
    await createFolderToleratingCollision(app, entry.path);
  }
  return `Restored folder ${entry.path}.`;
}

async function folderExists(app: App, path: string): Promise<boolean> {
  return app.vault.getAbstractFileByPath(path) instanceof TFolder || (await existsOnDisk(app, path));
}

async function createFolderToleratingCollision(app: App, path: string): Promise<void> {
  try {
    await app.vault.createFolder(path);
  } catch (error) {
    // Concurrent undo of the same folder — already restored, nothing to do.
    if (isFolderCollision(error) && (await existsOnDisk(app, path))) return;
    throw error;
  }
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
  // Drop empty segments (leading/trailing/consecutive slashes) so we never try
  // to create a folder with an empty name.
  await ensureFolderChain(app, parent.split("/").filter(Boolean), 0, "");
}

async function ensureFolderChain(
  app: App,
  segments: string[],
  index: number,
  prefix: string,
): Promise<void> {
  const segment = segments[index];
  if (segment === undefined) return;
  const current = prefix ? `${prefix}/${segment}` : segment;
  await ensureFolder(app, current);
  await ensureFolderChain(app, segments, index + 1, current);
}

async function ensureFolder(app: App, path: string): Promise<void> {
  if (app.vault.getFolderByPath(path)) return;
  // Same stale-tree guard as the vault tools: dot-folders on disk but
  // missing from the vault index must not trigger "Folder already exists."
  if (await existsOnDisk(app, path)) return;
  try {
    await app.vault.createFolder(path);
  } catch (error) {
    // Lost a race with an external sync — folder landed after the probe.
    if (isFolderCollision(error) && (await existsOnDisk(app, path))) return;
    throw error;
  }
}

/** True when the path exists on disk as a folder (single list probe). */
async function existsOnDisk(app: App, path: string): Promise<boolean> {
  try {
    await app.vault.adapter.list(path);
    return true;
  } catch {
    return false;
  }
}

function isFolderCollision(error: unknown): boolean {
  return String((error as Error)?.message ?? error ?? "").toLowerCase().includes("folder already exists");
}
