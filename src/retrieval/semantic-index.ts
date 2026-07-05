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
}

export interface SemanticIndexBootstrapResult {
  file: SemanticIndexFile;
  completed: boolean;
  cancelled: boolean;
}

export const SEMANTIC_INDEX_VERSION = 1;

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
    return parsed?.version === SEMANTIC_INDEX_VERSION && parsed.state?.status ? parsed : null;
  } catch {
    return null;
  }
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
