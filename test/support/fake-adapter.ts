import type { DataAdapter } from "obsidian";
import type { ToolArtifactStoreLike } from "../../src/artifacts/tool-artifact-store";

interface AdapterFault {
  error?: Error;
  gate?: Promise<void>;
}

/**
 * One in-memory DataAdapter for unit tests.
 *
 * Files, folders, rename, stat, and queued per-operation faults live in one
 * place, so a new DataAdapter method is added here instead of in every test.
 */
export class FakeAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  private readonly faults = new Map<string, AdapterFault[]>();

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) this.files.set(path, content);
  }

  failNextWrite(path: string, error: Error): this {
    return this.enqueue("write", path, { error });
  }

  failNextRead(path: string, error: Error): this {
    return this.enqueue("read", path, { error });
  }

  failNextAppend(path: string, error: Error): this {
    return this.enqueue("append", path, { error });
  }

  delayNextRead(path: string, gate: Promise<void>): this {
    return this.enqueue("read", path, { gate });
  }

  delayNextWrite(path: string, gate: Promise<void>): this {
    return this.enqueue("write", path, { gate });
  }

  delayNextAppend(path: string, gate: Promise<void>): this {
    return this.enqueue("append", path, { gate });
  }

  private enqueue(operation: string, path: string, fault: AdapterFault): this {
    const key = `${operation}:${path}`;
    const queue = this.faults.get(key) ?? [];
    queue.push(fault);
    this.faults.set(key, queue);
    return this;
  }

  private async applyFault(operation: string, path: string): Promise<void> {
    const queue = this.faults.get(`${operation}:${path}`);
    if (!queue || queue.length === 0) return;
    const fault = queue.shift() as AdapterFault;
    if (fault.gate) await fault.gate;
    if (fault.error) throw fault.error;
  }

  async write(path: string, data: string): Promise<void> {
    await this.applyFault("write", path);
    this.files.set(path, data);
  }

  async append(path: string, data: string): Promise<void> {
    await this.applyFault("append", path);
    this.files.set(path, (this.files.get(path) ?? "") + data);
  }

  async read(path: string): Promise<string> {
    await this.applyFault("read", path);
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Not found: ${path}`);
    return content;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.folders.delete(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content !== undefined) {
      this.files.set(newPath, content);
      this.files.delete(oldPath);
      return;
    }
    if (this.folders.has(oldPath)) {
      this.moveFolder(oldPath, newPath);
      return;
    }
    throw new Error(`Not found: ${oldPath}`);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path ? `${path}/` : "";
    const files = [...this.files.keys()].filter((file) => file.startsWith(prefix));
    const folders = [...this.folders].filter((folder) => folder.startsWith(prefix));
    return { files, folders };
  }

  async stat(
    path: string,
  ): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> {
    const content = this.files.get(path);
    if (content !== undefined) return { type: "file", ctime: 0, mtime: Date.now(), size: content.length };
    if (this.folders.has(path)) return { type: "folder", ctime: 0, mtime: Date.now(), size: 0 };
    return null;
  }

  asDataAdapter(): DataAdapter {
    return this as unknown as DataAdapter;
  }

  private moveFolder(oldPath: string, newPath: string): void {
    for (const folder of [...this.folders]) {
      if (folder === oldPath || folder.startsWith(`${oldPath}/`)) {
        this.folders.delete(folder);
        this.folders.add(`${newPath}${folder.slice(oldPath.length)}`);
      }
    }
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(`${oldPath}/`)) {
        const content = this.files.get(file) as string;
        this.files.delete(file);
        this.files.set(`${newPath}${file.slice(oldPath.length)}`, content);
      }
    }
  }
}

/** A DataAdapter over a fixed file map, for loaders that only read. */
export function fakeAdapter(files: Record<string, string> = {}): DataAdapter {
  return new FakeAdapter(files).asDataAdapter();
}

export const noopArtifactStore: ToolArtifactStoreLike = {
  async writeArtifact(input) {
    return {
      id: "artifact-1",
      label: input.label,
      sourceToolName: input.sourceToolName,
      contentType: input.contentType ?? "text/plain",
      createdAt: "2026-06-24T00:00:00.000Z",
      charLength: input.text.length,
    };
  },
  async readArtifact() {
    return {
      metadata: {
        id: "artifact-1",
        label: "Artifact",
        sourceToolName: "tool",
        contentType: "text/plain",
        createdAt: "2026-06-24T00:00:00.000Z",
        charLength: 0,
      },
      text: "",
    };
  },
};
