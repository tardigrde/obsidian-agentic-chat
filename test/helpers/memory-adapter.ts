import type { DataAdapter } from "obsidian";

/** Minimal in-memory DataAdapter for session-manager tests. */
export class MemoryAdapter {
  readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async append(path: string, data: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? "") + data);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Not found: ${path}`);
    return content;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path ? `${path}/` : "";
    const files = [...this.files.keys()].filter((file) => file.startsWith(prefix));
    return { files, folders: [] };
  }

  async stat(path: string): Promise<{ type: "file"; ctime: number; mtime: number; size: number } | null> {
    const content = this.files.get(path);
    if (content === undefined) return null;
    return { type: "file", ctime: 0, mtime: Date.now(), size: content.length };
  }

  asDataAdapter(): DataAdapter {
    return this as unknown as DataAdapter;
  }
}
