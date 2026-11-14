import { TFolder } from "obsidian";
import type { PluginVault } from "./plugin-vault";

const STAGE_PREFIX = ".importing-";
const BACKUP_PREFIX = ".importing-backup-";

/**
 * Remove leftover `.importing-*` stage folders a crashed install may have
 * left. A `.importing-backup-<name>` folder means the crash happened after
 * moving the old package aside but before the staged package landed. Restore
 * it when the target is missing or when an empty target can be safely
 * replaced; never delete the only package copy.
 *
 * One bad child must not hide every other package from the reload. The caller
 * runs this under the same lock as install transactions.
 *
 * Resolves true when a backup is still in place after the sweep: it then owns
 * the settings of its package, which must not be pruned yet.
 */
export async function sweepImportStages(vault: PluginVault): Promise<boolean> {
  for (const childPath of await importStagePaths(vault)) {
    try {
      await sweepImportStage(vault, childPath);
    } catch (error) {
      console.warn(`Agentic chat: could not clean import stage ${childPath}`, error);
    }
  }
  for (const path of await importStagePaths(vault)) {
    if (folderName(path).startsWith(BACKUP_PREFIX)) return true;
  }
  return false;
}

async function sweepImportStage(vault: PluginVault, childPath: string): Promise<void> {
  const writer = vault.writer();
  const childName = folderName(childPath);
  if (!childName.startsWith(BACKUP_PREFIX)) {
    await writer.removeFolder(childPath);
    return;
  }
  const name = childName.slice(BACKUP_PREFIX.length);
  const target = `${vault.folder()}/${name}`;
  const safeName = name !== "" && name !== "." && name !== ".." && !/[/\\]/.test(name);
  if (!safeName || !vault.contains(target)) {
    await writer.removeFolder(childPath);
    return;
  }
  const kind = await vault.kindOf(target);
  if (kind === "missing") {
    await writer.renameFolder(childPath, target);
    return;
  }
  if (kind === "file") return;
  if (await hasReadablePluginManifest(vault, target)) {
    // A real package owns the target; the backup is replaceable.
    await writer.removeFolder(childPath);
    return;
  }
  // A folder without a readable manifest is not a package owner. Only an
  // empty folder is safe to replace; anything else may be partial user data.
  if (!(await isFolderEmptyOnDisk(vault, target))) return;
  await writer.removeFolder(target);
  await writer.renameFolder(childPath, target);
}

/** Stage/backup folders from the tree and the adapter (tree can be stale). */
async function importStagePaths(vault: PluginVault): Promise<string[]> {
  const paths = new Set<string>();
  const root = vault.app.vault.getAbstractFileByPath(vault.folder());
  if (root instanceof TFolder) {
    for (const child of root.children ?? []) {
      if (child instanceof TFolder && child.name.startsWith(STAGE_PREFIX)) paths.add(child.path);
    }
  }
  try {
    const listing = await vault.app.vault.adapter.list(vault.folder());
    for (const folderPath of listing?.folders ?? []) {
      const normalized = folderPath.replace(/\/+$/, "");
      if (folderName(normalized).startsWith(STAGE_PREFIX)) paths.add(normalized);
    }
  } catch {
    // Adapter listing unavailable; tree entries (if any) still stand.
  }
  return [...paths];
}

async function hasReadablePluginManifest(vault: PluginVault, target: string): Promise<boolean> {
  try {
    const raw = await vault.app.vault.adapter.read(`${target}/plugin.json`);
    return raw.trim().length > 0;
  } catch {
    return false;
  }
}

async function isFolderEmptyOnDisk(vault: PluginVault, path: string): Promise<boolean> {
  try {
    const listing = await vault.app.vault.adapter.list(path);
    return (listing?.folders?.length ?? 0) === 0 && (listing?.files?.length ?? 0) === 0;
  } catch {
    return false;
  }
}

function folderName(path: string): string {
  return path.split("/").pop() ?? "";
}
