import type { DataAdapter } from "obsidian";

interface AdapterFault {
  error?: Error;
  gate?: Promise<void>;
}

/**
 * Minimal in-memory DataAdapter for session-manager tests.
 *
 * Faults are queued per operation and path. A fault is consumed once, so a test
 * can model one failed write, one delayed read, or one ENOENT without wrapping
 * every later call.
 */
export class MemoryAdapter {
  readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();
  private readonly faults = new Map<string, AdapterFault[]>();

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
