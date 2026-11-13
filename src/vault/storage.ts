import { TFile, TFolder, type App, type DataAdapter } from "obsidian";
import { getParentPath } from "./path";

/**
 * The one place that creates folders and replaces files on the vault's disk.
 *
 * Two layers write to the vault:
 * - the vault API (`vault.createFolder`), for paths the user sees in the file
 *   tree: agent tools, undo, and Agent Plugins packages;
 * - the raw adapter (`adapter.mkdir` / `adapter.write`), for plugin-internal
 *   state the vault tree never indexes: sessions, artifacts, memory, and the
 *   semantic index.
 *
 * Each layer has exactly one folder helper here, and every whole-file rewrite
 * of plugin state goes through `writeFileAtomically`.
 */

function folderSegments(folderPath: string): string[] {
  // Drop empty segments (leading/trailing/consecutive slashes) so no caller
  // ever asks the adapter for a folder with an empty name.
  const segments = folderPath.split("/").filter(Boolean);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

// ---------------------------------------------------------------------------
// Raw adapter layer
// ---------------------------------------------------------------------------

/** Create every missing folder of `folderPath` through the raw adapter. */
export async function ensureAdapterFolder(adapter: DataAdapter, folderPath: string): Promise<void> {
  for (const current of folderSegments(folderPath)) {
    if (!(await adapter.exists(current))) await adapter.mkdir(current);
  }
}

/** Create every missing parent folder of the file at `filePath`. */
export async function ensureAdapterParentFolder(adapter: DataAdapter, filePath: string): Promise<void> {
  await ensureAdapterFolder(adapter, getParentPath(filePath));
}

/** Best-effort removal for cleanup paths that must not fail the caller. */
export async function removeIfExists(adapter: DataAdapter, path: string): Promise<void> {
  try {
    if (await adapter.exists(path)) await adapter.remove(path);
  } catch {
    // Cleanup is best effort.
  }
}

/**
 * Rename `from` onto `to`. `DataAdapter.rename` does not promise to overwrite
 * an existing file; when it refuses and both files are present, the caller's
 * `replaceExisting` decides how to swap them (the default removes the target,
 * then renames). Any other rename failure is rethrown unchanged.
 */
export async function renameOver(
  adapter: DataAdapter,
  from: string,
  to: string,
  replaceExisting: () => Promise<void> = async () => {
    await adapter.remove(to);
    await adapter.rename(from, to);
  },
): Promise<void> {
  try {
    await adapter.rename(from, to);
    return;
  } catch (error) {
    // A missing staged file is a write-side failure; a missing target means
    // the rename failed for another reason. Neither is an overwrite refusal.
    if (!(await adapter.exists(from)) || !(await adapter.exists(to))) throw error;
  }
  await replaceExisting();
}

export interface AtomicWriteOptions {
  /** Staging path in the same folder. Defaults to `<path>.tmp`. */
  tempPath?: string;
  /** Overwrite strategy when the adapter refuses to rename over `path`. */
  replaceExisting?: () => Promise<void>;
}

/**
 * Replace a file without truncating it in place: the new bytes land in a temp
 * file in the same folder first, and only a complete rename makes them the
 * target. A crash leaves either the old file or the new one, plus at most a
 * stale temp file. The temp file is removed when the write fails.
 */
export async function writeFileAtomically(
  adapter: DataAdapter,
  path: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const tempPath = options.tempPath ?? `${path}.tmp`;
  await ensureAdapterParentFolder(adapter, path);
  try {
    await adapter.write(tempPath, content);
    await renameOver(adapter, tempPath, path, options.replaceExisting);
  } catch (error) {
    await removeIfExists(adapter, tempPath);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Vault API layer
// ---------------------------------------------------------------------------

/** True for the "Folder already exists" race (narrow: file collisions must not match). */
export function isFolderCollision(error: unknown): boolean {
  return String((error as Error)?.message ?? error ?? "").toLowerCase().includes("folder already exists");
}

/**
 * True when `path` is a folder in the vault tree or on disk. The vault tree
 * misses dot-folders (e.g. `.agentic-plugins`) created outside the session,
 * so a tree miss falls back to one adapter `list` probe.
 */
export async function isFolderOnDisk(app: App, path: string): Promise<boolean> {
  if (app.vault.getAbstractFileByPath(path) instanceof TFolder) return true;
  try {
    await app.vault.adapter.list(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create every missing folder of `folderPath` through the vault API, so the
 * file tree sees them. A folder that is on disk but missing from a stale tree
 * is skipped, or `vault.createFolder` would throw "Folder already exists.".
 * Losing a creation race to an external sync is absorbed only when the folder
 * really landed: a file at that path is a real conflict and still throws.
 */
export async function ensureVaultFolder(app: App, folderPath: string): Promise<void> {
  for (const current of folderSegments(folderPath)) {
    if (await isFolderOnDisk(app, current)) continue;
    try {
      await app.vault.createFolder(current);
    } catch (error) {
      if (isFolderCollision(error) && (await isFolderOnDisk(app, current))) continue;
      throw error;
    }
  }
}

/** Create every missing parent folder of the vault file at `filePath`. */
export async function ensureVaultParentFolder(app: App, filePath: string): Promise<void> {
  await ensureVaultFolder(app, getParentPath(filePath));
}

/** Create a whole file through the vault API, with its parent folders. */
export async function writeVaultFile(app: App, path: string, content: string): Promise<TFile> {
  await ensureVaultParentFolder(app, path);
  return app.vault.create(path, content);
}
