import { TFile, TFolder } from "obsidian";

/** In-memory stand-in for Obsidian's Vault, backing the vault-tool tests. */
export class FakeVault {
  private readonly root = new TFolder();
  private readonly files = new Map<string, { file: TFile; content: string }>();
  private readonly folders = new Map<string, TFolder>();

  constructor() {
    this.root.path = "/";
    this.root.name = "";
    this.folders.set("/", this.root);
  }

  getRoot(): TFolder {
    return this.root;
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()]
      .filter((entry) => entry.file.extension === "md")
      .map((entry) => entry.file);
  }

  async cachedRead(file: TFile): Promise<string> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`File not found: ${file.path}`);
    return entry.content;
  }

  async create(path: string, content: string): Promise<TFile> {
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
    const file = new TFile();
    file.path = path;
    file.name = path.split("/").pop() ?? path;
    file.extension = file.name.includes(".") ? file.name.split(".").pop() ?? "" : "";
    const parent = this.parentOf(path);
    file.parent = parent;
    parent.children.push(file);
    this.files.set(path, { file, content });
    return file;
  }

  async modify(file: TFile, content: string): Promise<void> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`File not found: ${file.path}`);
    entry.content = content;
  }

  async append(file: TFile, content: string): Promise<void> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`File not found: ${file.path}`);
    entry.content += content;
  }

  async createFolder(path: string): Promise<TFolder> {
    if (this.folders.has(path) || this.files.has(path)) {
      throw new Error(`Folder already exists: ${path}`);
    }
    const folder = new TFolder();
    folder.path = path;
    folder.name = path.split("/").pop() ?? path;
    const parent = this.parentOf(path);
    folder.parent = parent;
    parent.children.push(folder);
    this.folders.set(path, folder);
    return folder;
  }

  contentOf(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  hasFolder(path: string): boolean {
    return this.folders.has(path);
  }

  private parentOf(path: string): TFolder {
    const index = path.lastIndexOf("/");
    const parentPath = index === -1 ? "/" : path.slice(0, index);
    const folder = this.folders.get(parentPath);
    if (!folder) throw new Error(`Parent folder missing: ${parentPath}`);
    return folder;
  }
}

export class FakeApp {
  vault = new FakeVault();
  activeFile: TFile | null = null;
  workspace = {
    getActiveFile: (): TFile | null => this.activeFile,
  };
}
