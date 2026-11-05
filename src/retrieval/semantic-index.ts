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

  if (input.documents.length === 0) {
    const file = semanticIndexFile({
      scope: input.scope,
      status: { state: "skipped", scope: input.scope, reason: "scope-empty" },
      estimate,
      indexedDocumentIds: [],
      updatedAt: now(),
    });
    await writeSemanticIndexFile(input.adapter, input.path, file);
    return { file, completed: false, cancelled: false };
  }

  let snapshot = createEmbeddingIndexSnapshot({ scope: input.scope, model: input.embedder.profile, now: now() });
  let processedDocuments = 0;
  await writeSemanticIndexFile(
    input.adapter,
    input.path,
    semanticIndexFile({
      scope: input.scope,
      status: { state: "running", scope: input.scope, processedDocuments, totalDocuments: input.documents.length },
      estimate,
      indexedDocumentIds: [],
      snapshot,
      updatedAt: now(),
    }),
  );
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
      await writeSemanticIndexFile(
        input.adapter,
        input.path,
        semanticIndexFile({
          scope: input.scope,
          status: { state: "running", scope: input.scope, processedDocuments, totalDocuments: input.documents.length },
          estimate,
          indexedDocumentIds: snapshot.records.map((record) => record.documentId),
          snapshot,
          updatedAt: now(),
        }),
      );
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
    await writeSemanticIndexFile(input.adapter, input.path, file);
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
    await writeSemanticIndexFile(input.adapter, input.path, file);
    return { file, completed: false, cancelled };
  }
}

export async function readSemanticIndexFile(adapter: DataAdapter, path: string): Promise<SemanticIndexFile | null> {
  if (!(await adapter.exists(path))) return null;
  try {
    const parsed = JSON.parse(await adapter.read(path)) as SemanticIndexFile;
    if (parsed?.version !== SEMANTIC_INDEX_VERSION || !parsed.state?.status) return null;
    return await repairInterruptedIndex(adapter, path, parsed);
  } catch {
    return null;
  }
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
  const status = file.state.status;
  const repaired: SemanticIndexFile = {
    ...file,
    state: {
      ...file.state,
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
}

export async function writeSemanticIndexFile(
  adapter: DataAdapter,
  path: string,
  file: SemanticIndexFile,
): Promise<void> {
  await ensureParentDirs(adapter, path);
  await adapter.write(path, JSON.stringify(file, null, 2));
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
