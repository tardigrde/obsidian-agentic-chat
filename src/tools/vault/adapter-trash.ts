import { TFolder, type App } from "obsidian";

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
    if (/not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
    throw new Error(
      `Cannot delete ${path}: unable to inspect it (${error instanceof Error ? error.message : String(error)}). Refusing to guess file vs folder.`,
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

/** Trash an indexed folder bottom-up so non-empty deletes work without the adapter. */
export async function trashTreeFolderRecursive(app: App, folder: TFolder): Promise<void> {
  for (const child of [...folder.children]) {
    if (child instanceof TFolder) {
      await trashTreeFolderRecursive(app, child);
    } else {
      await app.fileManager.trashFile(child);
    }
  }
  await app.fileManager.trashFile(folder);
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
