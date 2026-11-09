/**
 * Cross-window lease for the semantic index writer.
 *
 * IndexedDB serializes readwrite transactions on one object store across the
 * windows of the same Obsidian app. A get-then-put in one transaction is atomic,
 * so two windows cannot both acquire an expired-or-free path. The in-memory
 * registry still owns the same-window fast path.
 */

export interface SemanticLeaseRecord {
  path: string;
  ownerId: string;
  touchedAt: number;
}

export interface SemanticLeaseStore {
  /** Acquire or renew the path for `ownerId`. False when another live owner holds it. */
  tryAcquire(path: string, ownerId: string, now: number, ttlMs: number): Promise<boolean>;
  release(path: string, ownerId: string): Promise<void>;
  /** Read the current record without changing it. Used only to explain a refusal. */
  peek?(path: string): Promise<SemanticLeaseRecord | undefined>;
}

const DB_NAME = "agentic-chat-semantic-leases";
const DB_VERSION = 1;
const STORE = "leases";

export class IndexedDbSemanticLeaseStore implements SemanticLeaseStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      const opening = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "path" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Could not open the semantic lease database."));
        request.onblocked = () => reject(new Error("The semantic lease database is blocked."));
      });
      // A failed open must be retried by the next call, not cached forever.
      opening.catch(() => {
        if (this.db === opening) this.db = null;
      });
      this.db = opening;
    }
    return this.db;
  }

  async tryAcquire(path: string, ownerId: string, now: number, ttlMs: number): Promise<boolean> {
    const db = await this.open();
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const get = store.get(path);
      let acquired = false;
      get.onsuccess = () => {
        const record = get.result as SemanticLeaseRecord | undefined;
        if (!record || record.ownerId === ownerId || now - record.touchedAt >= ttlMs) {
          store.put({ path, ownerId, touchedAt: now } satisfies SemanticLeaseRecord);
          acquired = true;
        }
      };
      tx.oncomplete = () => resolve(acquired);
      tx.onerror = () => reject(tx.error ?? new Error("Semantic lease transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("Semantic lease transaction aborted."));
    });
  }

  async peek(path: string): Promise<SemanticLeaseRecord | undefined> {
    const db = await this.open();
    return await new Promise<SemanticLeaseRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const get = tx.objectStore(STORE).get(path);
      tx.oncomplete = () => resolve(get.result as SemanticLeaseRecord | undefined);
      tx.onerror = () => reject(tx.error ?? new Error("Semantic lease read failed."));
      tx.onabort = () => reject(tx.error ?? new Error("Semantic lease read aborted."));
    });
  }

  async release(path: string, ownerId: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const get = store.get(path);
      get.onsuccess = () => {
        const record = get.result as SemanticLeaseRecord | undefined;
        if (record?.ownerId === ownerId) store.delete(path);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Semantic lease release failed."));
      tx.onabort = () => reject(tx.error ?? new Error("Semantic lease release aborted."));
    });
  }
}

/**
 * The desktop and mobile renderers have IndexedDB. Node test runners do not; the
 * registry then falls back to its in-memory map for single-window behavior.
 */
export function createDefaultSemanticLeaseStore(): SemanticLeaseStore | null {
  return typeof indexedDB === "undefined" ? null : new IndexedDbSemanticLeaseStore();
}
