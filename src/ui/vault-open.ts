import { Notice, TFile, TFolder, type App } from "obsidian";

/**
 * Open a vault path from the chat: a note opens, a folder is revealed in the
 * file explorer, and anything else shows a notice. `openLinkText` on a folder
 * or a missing path creates an empty note (U3 #4: a click on `shared` created
 * `shared.md`), so chat links never call it for those.
 */
export function openVaultPath(app: App, target: string, newLeaf = false): void {
  // A link may carry a heading or block subpath (`Note#Heading`); resolve the note part.
  const hash = target.indexOf("#");
  const linkpath = (hash >= 0 ? target.slice(0, hash) : target).replace(/\/+$/, "");
  const subpath = hash >= 0 ? target.slice(hash) : "";
  if (!linkpath) return;
  const entry = app.vault.getAbstractFileByPath(linkpath);
  if (entry instanceof TFolder) {
    revealFolder(app, entry);
    return;
  }
  const file = entry instanceof TFile ? entry : resolveLink(app, linkpath);
  if (!file) {
    new Notice(`Not found in the vault: ${linkpath}`);
    return;
  }
  void app.workspace.openLinkText(`${file.path}${subpath}`, "", newLeaf);
}

/** True when `path` names a vault folder (a folder is never a note link). */
export function isVaultFolder(app: App, path: string): boolean {
  if (!path) return false;
  return app.vault.getAbstractFileByPath(path.replace(/\/+$/, "")) instanceof TFolder;
}

function resolveLink(app: App, linktext: string): TFile | null {
  const dest = app.metadataCache?.getFirstLinkpathDest?.(linktext, "");
  return dest instanceof TFile ? dest : null;
}

interface FileExplorerInstance {
  revealInFolder?: (entry: TFolder) => void;
}

function revealFolder(app: App, folder: TFolder): void {
  const plugins = (app as unknown as {
    internalPlugins?: { getPluginById?: (id: string) => { instance?: FileExplorerInstance } | null };
  }).internalPlugins;
  const explorer = plugins?.getPluginById?.("file-explorer")?.instance;
  if (explorer?.revealInFolder) explorer.revealInFolder(folder);
}
