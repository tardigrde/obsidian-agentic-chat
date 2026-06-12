import { App, FuzzySuggestModal, TFolder } from "obsidian";

/** Fuzzy picker over every folder in the vault, including the root. */
export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private readonly onChoose: (folder: TFolder) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose a folder to attach…");
  }

  getItems(): TFolder[] {
    const folders: TFolder[] = [];
    const walk = (folder: TFolder): void => {
      folders.push(folder);
      for (const child of folder.children) {
        if (child instanceof TFolder) walk(child);
      }
    };
    walk(this.app.vault.getRoot());
    return folders;
  }

  getItemText(folder: TFolder): string {
    return folder.path === "/" ? "/ (vault root)" : folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoose(folder);
  }
}
