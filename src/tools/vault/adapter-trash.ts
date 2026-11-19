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
  if (!(await stillOnDisk(adapter, path))) return "trash";
  try {
    await adapter.trashLocal(path);
  } catch {
    // Fall through to the existence check and permanent removal.
  }
  if (!(await stillOnDisk(adapter, path))) return "trash";
  if (isFolder) await adapter.rmdir(path, false);
  else await adapter.remove(path);
  return "removed";
}

/**
 * Strict existence check for the trash postcondition: a failed check throws,
 * so it is never read as "gone". An adapter without `exists` (no disk to
 * check) trusts `trashFile`.
 */
async function stillOnDisk(adapter: App["vault"]["adapter"] | undefined, path: string): Promise<boolean> {
  if (typeof adapter?.exists !== "function") return false;
  return (await adapter.exists(path)) === true;
}

/**
 * Trash an indexed folder bottom-up so non-empty deletes work without the
 * adapter. Resolves with every path that bypassed the trash (empty when all of
 * it went to the trash).
 */
export async function trashTreeFolderRecursive(app: App, folder: TFolder): Promise<string[]> {
  const bypassed: string[] = [];
  await trashTreeInto(app, folder, bypassed);
  return bypassed;
}

/** The most bypassed paths a recursive delete message names one by one. */
const BYPASSED_PATHS_SHOWN = 20;

/**
 * The result of a recursive delete. A recursive delete has no per-file undo,
 * so the message names what bypassed the trash and is gone for good.
 */
export function recursiveDeletionMessage(path: string, bypassed: readonly string[]): string {
  if (bypassed.length === 0) return `Moved ${path} to trash.`;
  const shown = bypassed.slice(0, BYPASSED_PATHS_SHOWN).join(", ");
  const more = bypassed.length > BYPASSED_PATHS_SHOWN ? `, and ${bypassed.length - BYPASSED_PATHS_SHOWN} more` : "";
  return `Deleted ${path}. These bypassed the trash and are gone for good: ${shown}${more}.`;
}

/**
 * Collects every path that bypassed the trash. A failure part way through
 * names them: a recursive delete has no per-file undo, so the user must know
 * what is gone for good.
 */
async function trashTreeInto(app: App, folder: TFolder, bypassed: string[]): Promise<void> {
  const step = async (entry: TAbstractFile): Promise<void> => {
    try {
      if ((await trashVaultEntry(app, entry)) === "removed") bypassed.push(entry.path);
    } catch (error) {
      if (bypassed.length === 0) throw error;
      throw new Error(`${errorMessage(error)} Already deleted without trash: ${bypassed.join(", ")}.`, { cause: error });
    }
  };
  for (const child of [...folder.children]) {
    if (child instanceof TFolder) await trashTreeInto(app, child, bypassed);
    else await step(child);
  }
  await step(folder);
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
