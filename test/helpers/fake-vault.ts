import { TFile, TFolder } from "obsidian";

/** In-memory stand-in for Obsidian's Vault, backing the vault-tool tests. */
export class FakeVault {
  private readonly root = new TFolder();
  private readonly files = new Map<string, { file: TFile; content: string }>();
  private readonly folders = new Map<string, TFolder>();
  private readonly diskOnlyFolders = new Set<string>();
  private readonly diskOnlyFiles = new Map<string, string>();
  private readonly adapterExistsOverrides = new Map<string, boolean>();
  private readonly rmdirErrors = new Map<string, { code?: string; message?: string }>();

  constructor() {
    this.root.path = "/";
    this.root.name = "";
    this.folders.set("/", this.root);
  }

  addDiskOnlyFolder(path: string): void {
    this.diskOnlyFolders.add(path);
  }
  addDiskOnlyFile(path: string, content: string): void {
    this.diskOnlyFiles.set(path, content);
  }

  /** Hide a folder from the vault tree while keeping it on "disk" (adapter.exists true). Simulates dot-folder not indexed. */
  hideFolderFromTree(path: string): void {
    const folder = this.folders.get(path);
    if (folder) {
      this.folders.delete(path);
      this.diskOnlyFolders.add(path);
      // Remove from parent children
      const parent = folder.parent;
      if (parent) {
        parent.children = parent.children.filter((child) => child.path !== path);
      }
      // Also keep all nested files/folders on disk but hidden from tree
      for (const key of [...this.folders.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) {
          const nested = this.folders.get(key);
          if (!nested) continue;
          this.folders.delete(key);
          this.diskOnlyFolders.add(key);
          // Clear nested files from tree as well but keep on disk
        }
      }
      for (const key of [...this.files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) {
          const entry = this.files.get(key);
          if (!entry) continue;
          this.files.delete(key);
          this.diskOnlyFiles.set(key, entry.content);
        }
      }
    } else if (!this.diskOnlyFolders.has(path)) {
      this.diskOnlyFolders.add(path);
    }
  }

  /** Force adapter.exists to return a specific value for a path (e.g. simulate IO error via override + throw). */
  setAdapterExistsOverride(path: string, exists: boolean): void {
    this.adapterExistsOverrides.set(path, exists);
  }

  clearAdapterExistsOverride(path: string): void {
    this.adapterExistsOverrides.delete(path);
  }

  /** Make the next rmdir for this exact path throw an error with optional code. */
  setRmdirError(path: string, error: { code?: string; message?: string } | null): void {
    if (error) this.rmdirErrors.set(path, error);
    else this.rmdirErrors.delete(path);
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
    file.basename = file.name.includes(".") ? file.name.slice(0, file.name.lastIndexOf(".")) : file.name;
    await this.ensureFolderChain(this.parentPathOf(path));
    const parent = this.folders.get(this.parentPathOf(path)) ?? this.root;
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

  async process(file: TFile, fn: (content: string) => string): Promise<string> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`File not found: ${file.path}`);
    entry.content = fn(entry.content);
    return entry.content;
  }

  async append(file: TFile, content: string): Promise<void> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`File not found: ${file.path}`);
    entry.content += content;
  }

  async trash(file: TFile): Promise<void> {
    this.files.delete(file.path);
    const siblings = file.parent?.children;
    const index = siblings?.indexOf(file) ?? -1;
    if (siblings && index >= 0) siblings.splice(index, 1);
  }

  async createFolder(path: string): Promise<TFolder> {
    if (this.folders.has(path) || this.files.has(path)) {
      throw new Error(`Folder already exists: ${path}`);
    }
    await this.ensureFolderChain(path);
    const folder = this.folders.get(path) as TFolder;
    return folder;
  }

  contentOf(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  hasFolder(path: string): boolean {
    return this.folders.has(path);
  }

  /** Adapter-like surface the plugin touches directly (list/read/rename/rmdir). */
  readonly adapter: FakeVaultAdapter = {
    exists: async (path: string): Promise<boolean> => {
      if (this.adapterExistsOverrides.has(path)) return this.adapterExistsOverrides.get(path)!;
      if (this.diskOnlyFolders.has(path)) return true;
      if (this.diskOnlyFiles.has(path)) return true;
      // Disk-only prefix: any diskOnly file under this folder counts as exists for folder path
      for (const key of this.diskOnlyFolders) {
        if (key.startsWith(`${path}/`)) return true;
      }
      for (const key of this.diskOnlyFiles.keys()) {
        if (key === path || key.startsWith(`${path}/`)) return true;
      }
      return this.folders.has(path) || this.files.has(path);
    },
    list: async (path: string): Promise<{ folders: string[]; files: string[] }> => {
      const normalized = path === "/" ? "" : path.replace(/\/+$/, "");
      const prefix = normalized ? `${normalized}/` : "";
      const topLevel = (key: string): boolean => (prefix ? key.startsWith(prefix) && !key.slice(prefix.length).includes("/") : !key.includes("/"));
      const folderKeys = new Set<string>([...this.folders.keys(), ...this.diskOnlyFolders]);
      const fileKeys = new Set<string>([...this.files.keys(), ...this.diskOnlyFiles.keys()]);
      return {
        folders: [...folderKeys].filter((key) => key !== "/" && topLevel(key)),
        files: [...fileKeys].filter(topLevel),
      };
    },
    read: async (path: string): Promise<string> => {
      const entry = this.files.get(path);
      if (entry) return entry.content;
      const diskContent = this.diskOnlyFiles.get(path);
      if (diskContent !== undefined) return diskContent;
      throw new Error(`File not found: ${path}`);
    },
    write: async (path: string, content: string): Promise<void> => {
      const entry = this.files.get(path);
      if (entry) {
        entry.content = String(content);
        return;
      }
      if (this.diskOnlyFiles.has(path)) {
        this.diskOnlyFiles.set(path, String(content));
        return;
      }
      await this.create(path, String(content));
    },
    writeBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
      await this.create(path, new TextDecoder("utf-8").decode(new Uint8Array(data)));
    },
    rename: async (from: string, to: string): Promise<void> => {
      const moves: Array<[string, string]> = [];
      for (const key of this.files.keys()) {
        if (key === from || key.startsWith(`${from}/`)) moves.push([key, to + key.slice(from.length)]);
      }
      for (const key of this.diskOnlyFiles.keys()) {
        if (key === from || key.startsWith(`${from}/`)) moves.push([key, to + key.slice(from.length)]);
      }
      for (const [oldPath, newPath] of moves) {
        const entry = this.files.get(oldPath);
        if (entry) {
          this.files.delete(oldPath);
          entry.file.path = newPath;
          entry.file.name = newPath.split("/").pop() ?? newPath;
          entry.file.extension = entry.file.name.includes(".") ? entry.file.name.split(".").pop() ?? "" : "";
          entry.file.basename = entry.file.name.includes(".")
            ? entry.file.name.slice(0, entry.file.name.lastIndexOf("."))
            : entry.file.name;
          this.files.set(newPath, entry);
        } else {
          const content = this.diskOnlyFiles.get(oldPath);
          if (content !== undefined) {
            this.diskOnlyFiles.delete(oldPath);
            this.diskOnlyFiles.set(newPath, content);
          }
        }
      }
      const folderMoves: Array<[string, string]> = [];
      for (const key of this.folders.keys()) {
        if (key !== "/" && (key === from || key.startsWith(`${from}/`))) {
          folderMoves.push([key, to + key.slice(from.length)]);
        }
      }
      for (const key of this.diskOnlyFolders) {
        if (key === from || key.startsWith(`${from}/`)) {
          folderMoves.push([key, to + key.slice(from.length)]);
        }
      }
      // Deduplicate moves where both sets have same key (should not happen due to hide logic)
      const seen = new Set<string>();
      for (const [oldPath, newPath] of folderMoves) {
        if (seen.has(oldPath)) continue;
        seen.add(oldPath);
        const folder = this.folders.get(oldPath);
        if (folder) {
          this.folders.delete(oldPath);
          folder.path = newPath;
          folder.name = newPath.split("/").pop() ?? newPath;
          this.folders.set(newPath, folder);
        } else if (this.diskOnlyFolders.has(oldPath)) {
          this.diskOnlyFolders.delete(oldPath);
          this.diskOnlyFolders.add(newPath);
        }
      }
    },
    rmdir: async (path: string, _recursive: boolean): Promise<void> => {
      const err = this.rmdirErrors.get(path);
      if (err) {
        const error = Object.assign(new Error(err.message ?? "ENOENT: no such file or directory"), err);
        throw error;
      }
      const hasFolder = this.folders.has(path) || this.diskOnlyFolders.has(path);
      if (!hasFolder) {
        const hasFilePrefix = [...this.files.keys(), ...this.diskOnlyFiles.keys()].some((k) => k === path || k.startsWith(`${path}/`));
        if (!hasFilePrefix) return;
      }
      for (const key of [...this.files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
      }
      for (const key of [...this.diskOnlyFiles.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) this.diskOnlyFiles.delete(key);
      }
      for (const key of [...this.folders.keys()]) {
        if (key !== "/" && (key === path || key.startsWith(`${path}/`))) {
          const folder = this.folders.get(key);
          if (folder) {
            // detach from parent children
            const parent = folder.parent;
            if (parent) parent.children = parent.children.filter((c) => c.path !== key);
          }
          this.folders.delete(key);
        }
      }
      for (const key of [...this.diskOnlyFolders]) {
        if (key === path || key.startsWith(`${path}/`)) this.diskOnlyFolders.delete(key);
      }
    },
  };

  /** Recompute parent/children pointers after folder moves (rename/rmdir). */
  refreshTreePointers(): void {
    const sortedFolders = [...this.folders.keys()].sort((a, b) => a.split("/").length - b.split("/").length);
    for (const key of sortedFolders) {
      const folder = this.folders.get(key);
      if (!folder || key === "/") continue;
      const parent = key.includes("/") ? this.folders.get(this.parentPathOf(key)) : this.root;
      folder.parent = parent ?? this.root;
    }
    for (const folder of this.folders.values()) {
      const parent = folder.parent;
      if (!parent) continue;
      parent.children = [...parent.children].filter((child) => child.path !== folder.path);
      if (folder.path !== parent.path && !parent.children.includes(folder)) parent.children.push(folder);
    }
    for (const entry of this.files.values()) {
      const { file } = entry;
      const parent = file.path.includes("/") ? this.folders.get(this.parentPathOf(file.path)) : this.root;
      file.parent = parent ?? this.root;
      if (parent) {
        parent.children = [...parent.children].filter((child) => child.path !== file.path);
        if (!parent.children.includes(file)) parent.children.push(file);
      }
    }
  }

  private async ensureFolderChain(path: string): Promise<void> {
    if (!path) return;
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      const next = current ? `${current}/${segment}` : segment;
      if (!this.folders.has(next)) {
        const folder = new TFolder();
        folder.path = next;
        folder.name = segment;
        folder.parent = current ? (this.folders.get(current) ?? this.root) : this.root;
        folder.parent.children.push(folder);
        this.folders.set(next, folder);
      }
      current = next;
    }
  }

  private parentPathOf(path: string): string {
    const index = path.lastIndexOf("/");
    return index === -1 ? "" : path.slice(0, index);
  }
}

type FakeVaultAdapter = {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ folders: string[]; files: string[] }>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
};

export class FakeApp {
  vault = new FakeVault();
  activeFile: TFile | null = null;
  workspace = {
    getActiveFile: (): TFile | null => this.activeFile,
  };
}