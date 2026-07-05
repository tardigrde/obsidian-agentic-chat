import { type App, TFile, TFolder } from "obsidian";
import { getParentPath, normalizeVaultPath } from "../vault/path";
export { UNDOABLE_TOOLS } from "../tools/tool-contracts";

/** A reversible record of one mutating vault tool call. */
export type UndoEntry =
  | { kind: "content"; path: string; before: string | null } // write/edit; null = file didn't exist
  | { kind: "rename"; from: string; to: string }
  | { kind: "delete"; path: string; before: string }
  | { kind: "delete_folder"; path: string };

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
    if (toolName === "write") return { kind: "content", path, before: content };
    // edit/frontmatter need the file to have existed; nothing to restore otherwise.
    if ((toolName === "edit" || toolName === "set_properties") && content === null) return null;
    if (toolName === "edit") return { kind: "content", path, before: content };
    if (toolName === "set_properties") return { kind: "content", path, before: content };
    if (toolName === "delete") {
      if (content !== null) return { kind: "delete", path, before: content };
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
