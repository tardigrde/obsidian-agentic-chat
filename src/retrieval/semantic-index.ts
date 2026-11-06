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
  /** Called after each persisted batch so a cross-view lease can stay fresh. */
  onProgress?: () => void;
  /** Returns false when another writer owns the index; persistence then stops. */
  isLeaseOwned?: () => boolean;
}

export interface SemanticIndexBootstrapResult {
  file: SemanticIndexFile;
  completed: boolean;
  cancelled: boolean;
}

export const SEMANTIC_INDEX_VERSION = 1;

/** A stalled run loses its lease after this long without a persisted batch. */
export const DEFAULT_SEMANTIC_INDEX_LEASE_TTL_MS = 30 * 60 * 1000;

export interface SemanticIndexLease {
  /** Refresh the lease after progress so a long but healthy run keeps it. */
  touch(): void;
  release(): void;
  /** True while this lease still owns the path (not expired, not replaced). */
  isOwned(): boolean;
}

/**
 * One writer per index path across every ChatView. The lease is timestamped so
 * a crashed or stalled owner can be recovered instead of blocking indexing
 * forever.
 */
export class SemanticIndexLeaseRegistry {
  private readonly leases = new Map<string, { touchedAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_SEMANTIC_INDEX_LEASE_TTL_MS,
  ) {}

  acquire(path: string): SemanticIndexLease | null {
    const existing = this.leases.get(path);
    if (existing && this.now() - existing.touchedAt < this.ttlMs) return null;
    const entry = { touchedAt: this.now() };
    this.leases.set(path, entry);
    return {
      touch: () => {
        if (this.leases.get(path) === entry) entry.touchedAt = this.now();
      },
      release: () => {
        if (this.leases.get(path) === entry) this.leases.delete(path);
      },
      isOwned: () => this.leases.get(path) === entry && this.now() - entry.touchedAt < this.ttlMs,
    };
  }

  isLeased(path: string): boolean {
    const existing = this.leases.get(path);
    return Boolean(existing && this.now() - existing.touchedAt < this.ttlMs);
  }
}

export const semanticIndexLeases = new SemanticIndexLeaseRegistry();

export async function bootstrapSemanticIndex(input: SemanticIndexBootstrapInput): Promise<SemanticIndexBootstrapResult> {
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
  const ownsLease = input.isLeaseOwned ?? (() => true);
  const persist = async (file: SemanticIndexFile): Promise<boolean> => {
    if (!ownsLease()) return false;
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
  input.onProgress?.();

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
      input.onProgress?.();
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
  const lease = semanticIndexLeases.acquire(path);
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
    lease.release();
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
