import type { DataAdapter } from "obsidian";
import {
  buildEmbeddingInputs,
  createEmbeddingIndexRecords,
  createEmbeddingIndexSnapshot,
  upsertEmbeddingIndexRecords,
  type EmbeddingIndexSnapshot,
} from "./embeddings";
import {
  createScopedIndexState,
  estimateEmbeddingIndexCost,
  type EmbeddingIndexCostEstimate,
  type RetrievalDocument,
  type RetrievalEmbedder,
  type RetrievalIndexScope,
  type RetrievalIndexingStatus,
  type ScopedRetrievalIndexState,
} from "./policy";
import { createDefaultSemanticLeaseStore, type SemanticLeaseStore } from "./semantic-index-lease-store";

export interface SemanticIndexFile {
  version: 1;
  updatedAt: number;
  state: ScopedRetrievalIndexState;
  snapshot?: EmbeddingIndexSnapshot;
}

export interface SemanticIndexBootstrapInput {
  adapter: DataAdapter;
  path: string;
  scope: RetrievalIndexScope;
  documents: readonly RetrievalDocument[];
  embedder: RetrievalEmbedder;
  batchSize: number;
  estimate?: EmbeddingIndexCostEstimate;
  now?: () => number;
  signal?: AbortSignal;
  /** Called after the writer owns the path, before the first persisted write. */
  onLeaseAcquired?: () => void;
  /** Test seam: the registry that owns the path. Defaults to the shared registry. */
  leases?: Pick<SemanticIndexLeaseRegistry, "acquireDurable"> & Partial<Pick<SemanticIndexLeaseRegistry, "describeHold">>;
}

export type SemanticIndexLeaseFailure =
  | {
      reason: "held";
      /** Time since the holder's last heartbeat, when the store could tell. */
      heldForMs?: number;
      /** Time until that lease expires if its holder is gone. */
      retryInMs?: number;
    }
  | { reason: "store-error"; message: string };

export type SemanticIndexBootstrapResult =
  | {
      file: SemanticIndexFile;
      completed: boolean;
      cancelled: boolean;
      leaseFailure?: undefined;
    }
  | {
      /** Null when the writer could not own the path, so it wrote nothing. */
      file: null;
      completed: false;
      cancelled: false;
      leaseFailure: SemanticIndexLeaseFailure;
    };

export const SEMANTIC_INDEX_VERSION = 1;

/**
 * A lease expires this long after its last heartbeat. A live writer renews it on
 * a timer (every quarter TTL) and after each persisted batch, so only a crashed
 * or reloaded owner lets it lapse, and the next load waits at most this long.
 */
export const DEFAULT_SEMANTIC_INDEX_LEASE_TTL_MS = 2 * 60 * 1000;

export interface SemanticIndexLeaseHold {
  heldForMs: number;
  retryInMs: number;
}

let semanticLeaseNamespace = "vault";

/** Namespace store keys by vault so two vaults do not block each other. */
export function setSemanticLeaseNamespace(namespace: string): void {
  const trimmed = namespace.trim();
  if (trimmed) semanticLeaseNamespace = trimmed;
}

function semanticLeaseKey(path: string): string {
  return `${semanticLeaseNamespace}:${path}`;
}

export interface SemanticIndexLease {
  /** Refresh the lease after progress so a long but healthy run keeps it. */
  touch(): void;
  release(): void | Promise<void>;
  /** True while this lease still owns the path (not expired, not replaced). */
  isOwned(): boolean;
}

/**
 * One writer per index path across every ChatView. The lease is timestamped so
 * a crashed or stalled owner can be recovered instead of blocking indexing
 * forever.
 */
let leaseOwnerSequence = 0;

function nextLeaseOwnerId(): string {
  leaseOwnerSequence += 1;
  return `w${Date.now().toString(36)}-${leaseOwnerSequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SemanticIndexLeaseRegistry {
  private readonly leases = new Map<string, { touchedAt: number }>();
  private readonly ownerId = nextLeaseOwnerId();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_SEMANTIC_INDEX_LEASE_TTL_MS,
    private readonly store: SemanticLeaseStore | null = createDefaultSemanticLeaseStore(),
  ) {}

  /**
   * Claim the path in the shared store after taking the same-window lease.
   * Returns the local lease only when IndexedDB is unavailable (Node tests).
   * A store failure fails closed: the caller must not write without the shared
   * lease. A lost renewal sets `isOwned` false before the next persisted batch.
   */
  async acquireDurable(path: string): Promise<SemanticIndexLease | null> {
    const key = semanticLeaseKey(path);
    const local = this.acquire(path);
    if (!local) return null;
    if (!this.store) return this.withLocalHeartbeat(local);
    const store = this.store;
    try {
      const acquired = await store.tryAcquire(key, this.ownerId, this.now(), this.ttlMs);
      if (!acquired) {
        void local.release();
        return null;
      }
    } catch (error) {
      void local.release();
      throw new Error("Could not acquire the shared semantic index lease. Close other Obsidian windows and retry.", {
        cause: error,
      });
    }
    let owned = true;
    let touchedAt = this.now();
    const renew = () => {
      if (!owned) return;
      local.touch();
      touchedAt = this.now();
      void store
        .tryAcquire(key, this.ownerId, touchedAt, this.ttlMs)
        .then((renewed) => {
          if (!renewed) owned = false;
        })
        .catch(() => {
          // A failed renewal cannot prove ownership; stop before the next write.
          owned = false;
        });
    };
    const heartbeat = window.setInterval(renew, this.heartbeatMs());
    return {
      touch: renew,
      release: () => {
        owned = false;
        window.clearInterval(heartbeat);
        void local.release();
        return store.release(key, this.ownerId).catch((error) => {
          console.warn("Agentic Chat: could not release the semantic index lease", error);
        });
      },
      isOwned: () => owned && this.now() - touchedAt < this.ttlMs && local.isOwned(),
    };
  }

  /**
   * Explain a refused acquisition: how long ago the holder last renewed and when
   * its lease lapses if that holder is gone. Null when nothing can be read.
   */
  async describeHold(path: string): Promise<SemanticIndexLeaseHold | null> {
    const key = semanticLeaseKey(path);
    let touchedAt = this.leases.get(key)?.touchedAt;
    if (touchedAt === undefined && this.store?.peek) {
      try {
        touchedAt = (await this.store.peek(key))?.touchedAt;
      } catch {
        return null;
      }
    }
    if (touchedAt === undefined) return null;
    const heldForMs = Math.max(0, this.now() - touchedAt);
    return { heldForMs, retryInMs: Math.max(0, this.ttlMs - heldForMs) };
  }

  private heartbeatMs(): number {
    return Math.max(1, Math.floor(this.ttlMs / 4));
  }

  /** Without a shared store, still keep a long batch from outliving the short TTL. */
  private withLocalHeartbeat(local: SemanticIndexLease): SemanticIndexLease {
    const heartbeat = window.setInterval(() => local.touch(), this.heartbeatMs());
    return {
      touch: () => local.touch(),
      release: () => {
        window.clearInterval(heartbeat);
        return local.release();
      },
      isOwned: () => local.isOwned(),
    };
  }

  acquire(path: string): SemanticIndexLease | null {
    const key = semanticLeaseKey(path);
    const existing = this.leases.get(key);
    if (existing && this.now() - existing.touchedAt < this.ttlMs) return null;
    const entry = { touchedAt: this.now() };
    this.leases.set(key, entry);
    return {
      touch: () => {
        if (this.leases.get(key) === entry) entry.touchedAt = this.now();
      },
      release: () => {
        if (this.leases.get(key) === entry) this.leases.delete(key);
      },
      isOwned: () => this.leases.get(key) === entry && this.now() - entry.touchedAt < this.ttlMs,
    };
  }

  isLeased(path: string): boolean {
    const key = semanticLeaseKey(path);
    const existing = this.leases.get(key);
    return Boolean(existing && this.now() - existing.touchedAt < this.ttlMs);
  }
}

export const semanticIndexLeases = new SemanticIndexLeaseRegistry();

/** One acquisition path for the writer and for the read-repair critical section. */
async function acquireSemanticIndexWriterLease(
  leases: Pick<SemanticIndexLeaseRegistry, "acquireDurable">,
  path: string,
): Promise<SemanticIndexLease | null> {
  return await leases.acquireDurable(path);
}

/**
 * The writer owns the lease: it claims the path before the first read or write,
 * keeps the claim fresh on a heartbeat timer and after every persisted batch,
 * and releases it in `finally`. A direct caller therefore cannot write without the lease.
 */
export async function bootstrapSemanticIndex(input: SemanticIndexBootstrapInput): Promise<SemanticIndexBootstrapResult> {
  const leases = input.leases ?? semanticIndexLeases;
  let acquired: SemanticIndexLease | null;
  try {
    acquired = await acquireSemanticIndexWriterLease(leases, input.path);
  } catch (error) {
    return {
      file: null,
      completed: false,
      cancelled: false,
      leaseFailure: { reason: "store-error", message: errorMessage(error) },
    };
  }
  if (!acquired) {
    const hold = (await leases.describeHold?.(input.path)) ?? {};
    return { file: null, completed: false, cancelled: false, leaseFailure: { reason: "held", ...hold } };
  }
  const lease = acquired;
  try {
    input.onLeaseAcquired?.();
    return await runSemanticIndexBootstrap({
      ...input,
      isLeaseOwned: () => lease.isOwned(),
      onProgress: () => lease.touch(),
    });
  } finally {
    await lease.release();
  }
}

interface SemanticIndexBootstrapRunInput extends SemanticIndexBootstrapInput {
  isLeaseOwned: () => boolean;
  onProgress: () => void;
}

async function runSemanticIndexBootstrap(input: SemanticIndexBootstrapRunInput): Promise<SemanticIndexBootstrapResult> {
  const now = input.now ?? Date.now;
  const batchSize = Math.max(1, Math.floor(input.batchSize));
  const estimate =
    input.estimate ??
    estimateEmbeddingIndexCost({
      scope: input.scope,
      model: input.embedder.profile,
      documentCount: input.documents.length,
      characterCount: input.documents.reduce((sum, document) => sum + document.content.length, 0),
      indexingBatchSize: batchSize,
    });
  const persist = async (file: SemanticIndexFile): Promise<boolean> => {
    if (!input.isLeaseOwned()) return false;
    await writeSemanticIndexFile(input.adapter, input.path, file);
    return true;
  };

  if (input.documents.length === 0) {
    const file = semanticIndexFile({
      scope: input.scope,
      status: { state: "skipped", scope: input.scope, reason: "scope-empty" },
      estimate,
      indexedDocumentIds: [],
      updatedAt: now(),
    });
    await persist(file);
    return { file, completed: false, cancelled: false };
  }

  let snapshot = createEmbeddingIndexSnapshot({ scope: input.scope, model: input.embedder.profile, now: now() });
  let processedDocuments = 0;
  const runningFile = semanticIndexFile({
    scope: input.scope,
    status: { state: "running", scope: input.scope, processedDocuments, totalDocuments: input.documents.length },
    estimate,
    indexedDocumentIds: [],
    snapshot,
    updatedAt: now(),
  });
  if (!(await persist(runningFile))) return { file: runningFile, completed: false, cancelled: false };
  input.onProgress();

  try {
    for (let index = 0; index < input.documents.length; index += batchSize) {
      throwIfAborted(input.signal);
      const documents = input.documents.slice(index, index + batchSize);
      const embeddings = await input.embedder.embedBatch(buildEmbeddingInputs(documents), {
        batchSize,
        signal: input.signal,
      });
      const records = await createEmbeddingIndexRecords(documents, embeddings, { now: now() });
      snapshot = upsertEmbeddingIndexRecords(snapshot, records, { now: now() });
      processedDocuments += documents.length;
      const batchFile = semanticIndexFile({
        scope: input.scope,
        status: { state: "running", scope: input.scope, processedDocuments, totalDocuments: input.documents.length },
        estimate,
        indexedDocumentIds: snapshot.records.map((record) => record.documentId),
        snapshot,
        updatedAt: now(),
      });
      if (!(await persist(batchFile))) return { file: batchFile, completed: false, cancelled: false };
      input.onProgress();
    }
    const file = semanticIndexFile({
      scope: input.scope,
      status: { state: "complete", scope: input.scope, totalDocuments: input.documents.length },
      estimate,
      indexedDocumentIds: snapshot.records.map((record) => record.documentId),
      snapshot,
      updatedAt: now(),
    });
    if (!(await persist(file))) return { file, completed: false, cancelled: false };
    return { file, completed: true, cancelled: false };
  } catch (error) {
    const cancelled = input.signal?.aborted === true || /cancelled|aborted/i.test(errorMessage(error));
    const status: RetrievalIndexingStatus = cancelled
      ? {
          state: "cancelled",
          scope: input.scope,
          processedDocuments,
          totalDocuments: input.documents.length,
          reason: "user cancelled",
        }
      : {
          state: "failed",
          scope: input.scope,
          processedDocuments,
          totalDocuments: input.documents.length,
          error: errorMessage(error),
        };
    const file = semanticIndexFile({
      scope: input.scope,
      status,
      estimate,
      indexedDocumentIds: snapshot.records.map((record) => record.documentId),
      snapshot,
      updatedAt: now(),
    });
    await persist(file);
    return { file, completed: false, cancelled };
  }
}

export async function readSemanticIndexFile(adapter: DataAdapter, path: string): Promise<SemanticIndexFile | null> {
  const primary = await readValidSemanticIndexFile(adapter, path);
  if (primary) {
    if (primary.state.status.state === "running") {
      return await repairInterruptedIndex(adapter, path, primary);
    }
    return primary;
  }
  // A missing or corrupt target must not hide the last complete index. The
  // backup is written from a complete target before any replacement.
  return await readValidSemanticIndexFile(adapter, semanticIndexBackupPath(path));
}

async function readValidSemanticIndexFile(
  adapter: DataAdapter,
  path: string,
): Promise<SemanticIndexFile | null> {
  if (!(await adapter.exists(path))) return null;
  try {
    const parsed = JSON.parse(await adapter.read(path)) as SemanticIndexFile;
    if (parsed?.version !== SEMANTIC_INDEX_VERSION || !parsed.state?.status) return null;
    return parsed;
  } catch {
    return null;
  }
}

type CurrentSemanticIndex =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "valid"; file: SemanticIndexFile };

/**
 * A read error is not the same as an absent file. The writer must know the
 * difference before it removes a target it cannot validate.
 */
async function readCurrentSemanticIndex(
  adapter: DataAdapter,
  path: string,
): Promise<CurrentSemanticIndex> {
  if (!(await adapter.exists(path))) return { kind: "missing" };
  try {
    const parsed = JSON.parse(await adapter.read(path)) as SemanticIndexFile;
    if (parsed?.version !== SEMANTIC_INDEX_VERSION || !parsed.state?.status) {
      return { kind: "unreadable" };
    }
    return { kind: "valid", file: parsed };
  } catch {
    return { kind: "unreadable" };
  }
}

async function hasCompleteSemanticIndexBackup(
  adapter: DataAdapter,
  path: string,
): Promise<boolean> {
  const backup = await readValidSemanticIndexFile(adapter, semanticIndexBackupPath(path));
  return backup?.state.status.state === "complete";
}

/**
 * A `running` status on disk can only mean the previous writer stopped before
 * it could record a terminal state. Repair it on read so the status never lies.
 */
async function repairInterruptedIndex(
  adapter: DataAdapter,
  path: string,
  file: SemanticIndexFile,
): Promise<SemanticIndexFile> {
  if (file.state.status.state !== "running") return file;
  // Hold the same lease a writer uses. Without it, a writer can acquire the
  // index between the check and the write and lose its file to our repair.
  let lease: SemanticIndexLease | null;
  try {
    lease = await acquireSemanticIndexWriterLease(semanticIndexLeases, path);
  } catch {
    // A status read must still work when the shared lease store is unavailable.
    return file;
  }
  if (!lease) return file;
  try {
    // Re-read before writing: a status read can race a completed run, and the
    // newer snapshot must win over this stale repair.
    let latest = file;
    try {
      const candidate = JSON.parse(await adapter.read(path)) as SemanticIndexFile;
      if (candidate?.version === SEMANTIC_INDEX_VERSION && candidate.state?.status) latest = candidate;
    } catch {
      return file;
    }
    if (latest.updatedAt !== file.updatedAt) return latest;
    if (latest.state.status.state !== "running") return latest;

    const status = latest.state.status;
    const repaired: SemanticIndexFile = {
      ...latest,
      state: {
        ...latest.state,
        status: {
          state: "failed",
          scope: status.scope,
          processedDocuments: status.processedDocuments,
          totalDocuments: status.totalDocuments,
          error: "Semantic indexing was interrupted before it finished. Run it again to complete the index.",
        },
      },
    };
    try {
      await writeSemanticIndexFile(adapter, path, repaired);
    } catch {
      // A read-only adapter still gets the repaired view; persistence is best effort.
    }
    return repaired;
  } finally {
    await lease.release();
  }
}

export async function writeSemanticIndexFile(
  adapter: DataAdapter,
  path: string,
  file: SemanticIndexFile,
): Promise<void> {
  await ensureParentDirs(adapter, path);
  const serialized = JSON.stringify(file, null, 2);
  const tempPath = semanticIndexTempPath(path);

  // Never truncate the live index in place. The new bytes land in a temp file
  // first; only a complete rename makes them the target.
  await adapter.write(tempPath, serialized);

  // Preserve the current complete index before any replacement, including the
  // first `running` write of a rebuild. A running or failed target is not a
  // complete index, so it never overwrites the backup.
  const current = await readCurrentSemanticIndex(adapter, path);
  if (current.kind === "valid" && current.file.state.status.state === "complete") {
    await writeSemanticIndexBackup(adapter, semanticIndexBackupPath(path), current.file);
  } else if (current.kind === "unreadable" && !(await hasCompleteSemanticIndexBackup(adapter, path))) {
    throw new Error(
      "Refusing to replace an unreadable semantic index without a complete backup.",
    );
  }

  // A target that is complete, or unreadable and protected by a backup, may be
  // removed only when a complete backup is still present.
  const requireBackup =
    current.kind === "unreadable" ||
    (current.kind === "valid" && current.file.state.status.state === "complete");
  await replaceSemanticIndexFile(adapter, tempPath, path, requireBackup ? path : undefined);
}

async function writeSemanticIndexBackup(
  adapter: DataAdapter,
  backupPath: string,
  file: SemanticIndexFile,
): Promise<void> {
  const tempPath = semanticIndexTempPath(backupPath);
  await adapter.write(tempPath, JSON.stringify(file, null, 2));
  await replaceSemanticIndexFile(adapter, tempPath, backupPath);
}

async function replaceSemanticIndexFile(
  adapter: DataAdapter,
  from: string,
  to: string,
  requireBackupFor?: string,
): Promise<void> {
  try {
    await adapter.rename(from, to);
    return;
  } catch (error) {
    // Some adapters refuse to rename over an existing file. Remove the target
    // only when both files exist and the complete index is protected.
    if (!(await adapter.exists(to)) || !(await adapter.exists(from))) throw error;
    if (requireBackupFor && !(await hasCompleteSemanticIndexBackup(adapter, requireBackupFor))) {
      throw error;
    }
  }
  await adapter.remove(to);
  await adapter.rename(from, to);
}

function semanticIndexTempPath(path: string): string {
  return `${path}.tmp`;
}

function semanticIndexBackupPath(path: string): string {
  return `${path}.bak`;
}

export function semanticIndexFile(input: {
  scope: RetrievalIndexScope;
  status: RetrievalIndexingStatus;
  estimate?: EmbeddingIndexCostEstimate;
  indexedDocumentIds: readonly string[];
  snapshot?: EmbeddingIndexSnapshot;
  updatedAt: number;
}): SemanticIndexFile {
  return {
    version: SEMANTIC_INDEX_VERSION,
    updatedAt: input.updatedAt,
    state: createScopedIndexState({
      scope: input.scope,
      status: input.status,
      estimate: input.estimate,
      indexedDocumentIds: input.indexedDocumentIds,
    }),
    snapshot: input.snapshot,
  };
}

export function semanticIndexPath(pluginDir: string): string {
  return `${pluginDir.replace(/\/+$/, "")}/semantic-index/index.json`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("semantic indexing cancelled");
}

async function ensureParentDirs(adapter: DataAdapter, path: string): Promise<void> {
  const parts = path.split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    if (!part) continue;
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) await adapter.mkdir(current);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
