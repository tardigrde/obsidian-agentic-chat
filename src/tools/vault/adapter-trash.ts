import { TFolder, type App, type TAbstractFile } from "obsidian";
import { errorMessage } from "../../utils/errors";

export async function adapterPathExists(adapter: App["vault"]["adapter"], path: string): Promise<boolean> {
  try {
    return (await adapter?.exists(path)) === true;
  } catch {
    return false;
  }
}

export interface AdapterDeletionTarget {
  isFolder: boolean;
  childCount: number;
}

/**
 * Fail closed: classify via stat, never by elimination. A listing failure must
 * not demote a folder to the file path (which would trash a non-empty folder
 * past the recursive guard).
 */
export async function inspectAdapterTarget(
  adapter: App["vault"]["adapter"],
  path: string,
): Promise<AdapterDeletionTarget> {
  try {
    const stat = await adapter.stat(path);
    if (!stat) throw new Error(`File or folder not found: ${path}`);
    const isFolder = stat.type === "folder";
    return { isFolder, childCount: isFolder ? await countAdapterChildren(adapter, path) : 0 };
  } catch (error) {
    if (/not found/i.test(errorMessage(error))) throw error;
    throw new Error(
      `Cannot delete ${path}: unable to inspect it (${errorMessage(error)}). Refusing to guess file vs folder.`,
      { cause: error },
    );
  }
}

async function countAdapterChildren(adapter: App["vault"]["adapter"], path: string): Promise<number> {
  const listing = await adapter.list(path);
  return (listing?.folders?.length ?? 0) + (listing?.files?.length ?? 0);
}

export function adapterDeletionMessage(path: string, disposition: "trash" | "removed"): string {
  return disposition === "trash" ? `Moved ${path} to trash.` : `Deleted ${path} (bypassed trash).`;
}

/**
 * Trash one indexed file or empty folder with the user's trash setting, then
 * check that it is gone. Obsidian's system trash can return without moving
 * anything (a Linux desktop with no trash service), so a delete that did not
 * happen falls back to the vault's own `.trash` folder, then to permanent
 * removal. The caller reports the real outcome, never a delete that did not
 * happen.
 */
export async function trashVaultEntry(app: App, entry: TAbstractFile): Promise<"trash" | "removed"> {
  const path = entry.path;
  const isFolder = entry instanceof TFolder;
  await app.fileManager.trashFile(entry);
  const adapter = app.vault.adapter;
  if (!(await adapterPathExists(adapter, path))) return "trash";
  try {
    await adapter.trashLocal(path);
  } catch {
    // Fall through to the existence check and permanent removal.
  }
  if (!(await adapterPathExists(adapter, path))) return "trash";
  if (isFolder) await adapter.rmdir(path, false);
  else await adapter.remove(path);
  return "removed";
}

/**
 * Trash an indexed folder bottom-up so non-empty deletes work without the
 * adapter. Returns "removed" if any part bypassed the trash.
 */
export async function trashTreeFolderRecursive(app: App, folder: TFolder): Promise<"trash" | "removed"> {
  let disposition: "trash" | "removed" = "trash";
  for (const child of [...folder.children]) {
    const result = child instanceof TFolder ? await trashTreeFolderRecursive(app, child) : await trashVaultEntry(app, child);
    if (result === "removed") disposition = "removed";
  }
  if ((await trashVaultEntry(app, folder)) === "removed") disposition = "removed";
  return disposition;
}

/** Prefer trash for adapter-level deletes; fall back to permanent removal. */
export async function trashAdapterFile(app: App, path: string): Promise<"trash" | "removed"> {
  try {
    if (await app.vault.adapter.trashSystem(path)) return "trash";
  } catch {
    // Fall through to trashLocal / remove.
  }
  try {
    await app.vault.adapter.trashLocal(path);
    return "trash";
  } catch {
    // Fall through to permanent removal.
  }
  await app.vault.adapter.remove(path);
  return "removed";
}

/** Prefer trash for adapter-level folder deletes; fall back to rmdir. */
export async function trashAdapterFolder(app: App, path: string, recursive: boolean): Promise<"trash" | "removed"> {
  try {
    if (await app.vault.adapter.trashSystem(path)) return "trash";
  } catch {
    // Fall through to trashLocal / rmdir.
  }
  try {
    await app.vault.adapter.trashLocal(path);
    return "trash";
  } catch {
    // Fall through to permanent removal.
  }
  await app.vault.adapter.rmdir(path, recursive);
  return "removed";
}
