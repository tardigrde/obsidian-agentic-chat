import type { EmbeddingIndexSnapshot, EmbeddingIndexRecord } from "./embeddings";
import type { LexicalVaultQaResponse, LexicalVaultQaResult } from "./lexical";
import type { EmbeddingResult, RetrievalDocument } from "./policy";

export interface SemanticVaultCandidate {
  document: RetrievalDocument;
  score: number;
  similarity: number;
  record: EmbeddingIndexRecord;
}

export interface SemanticRetrievalInput {
  documents: readonly RetrievalDocument[];
  snapshot: EmbeddingIndexSnapshot | null | undefined;
  queryEmbedding: Pick<EmbeddingResult, "values" | "dimensions" | "modelId">;
  minSimilarity?: number;
  maxResults?: number;
}

export function retrieveSemanticVaultCandidates(input: SemanticRetrievalInput): SemanticVaultCandidate[] {
  if (!input.snapshot || input.snapshot.model.id !== input.queryEmbedding.modelId) return [];
  if (input.snapshot.model.dimensions !== input.queryEmbedding.dimensions) return [];
  const minSimilarity = input.minSimilarity ?? 0.15;
  const maxResults = Math.max(1, input.maxResults ?? 20);
  const documents = new Map(input.documents.map((document) => [document.id, document]));
  const candidates: SemanticVaultCandidate[] = [];

  for (const record of input.snapshot.records) {
    const document = documents.get(record.documentId);
    if (!document) continue;
    if (record.modelId !== input.queryEmbedding.modelId || record.dimensions !== input.queryEmbedding.dimensions) continue;
    const similarity = cosineSimilarity(input.queryEmbedding.values, record.vector);
    if (similarity < minSimilarity) continue;
    candidates.push({
      document,
      record,
      similarity,
      score: Number((similarity * 2).toFixed(6)),
    });
  }

  const sorted = [...candidates].sort((left, right) => right.score - left.score || left.document.path.localeCompare(right.document.path));
  return sorted.slice(0, maxResults);
}

export function retrieveSemanticCandidatesForDocument(input: {
  seed: RetrievalDocument;
  documents: readonly RetrievalDocument[];
  snapshot: EmbeddingIndexSnapshot | null | undefined;
  minSimilarity?: number;
  maxResults?: number;
}): SemanticVaultCandidate[] {
  const seedRecord = input.snapshot?.records.find((record) => record.documentId === input.seed.id);
  if (!seedRecord) return [];
  return retrieveSemanticVaultCandidates({
    documents: input.documents.filter((document) => document.id !== input.seed.id),
    snapshot: input.snapshot,
    queryEmbedding: {
      modelId: seedRecord.modelId,
      dimensions: seedRecord.dimensions,
      values: seedRecord.vector,
    },
    minSimilarity: input.minSimilarity,
    maxResults: input.maxResults,
  });
}

export function mergeSemanticCandidates(
  lexical: LexicalVaultQaResponse,
  semantic: readonly SemanticVaultCandidate[],
  options: { maxResults?: number } = {},
): LexicalVaultQaResponse {
  if (semantic.length === 0) return lexical;
  const maxResults = Math.max(1, options.maxResults ?? (lexical.results.length || 10));
  const byId = new Map(lexical.results.map((result) => [result.document.id, cloneResult(result)]));

  for (const candidate of semantic) {
    const signal = {
      kind: "semantic" as const,
      score: candidate.score,
      detail: "semantic similarity",
      matches: [candidate.similarity.toFixed(3)],
    };
    const existing = byId.get(candidate.document.id);
    if (existing) {
      existing.score = Number((existing.score + candidate.score).toFixed(6));
      existing.signals = [...existing.signals, signal];
      continue;
    }
    byId.set(candidate.document.id, {
      document: candidate.document,
      score: candidate.score,
      signals: [signal],
      snippets: [],
    });
  }

  const candidates = [...byId.values()].sort(compareHybridResults);
  const results = candidates.slice(lexical.offset, lexical.offset + maxResults);
  const nextOffset = lexical.offset + results.length;
  return {
    ...lexical,
    results,
    totalMatches: candidates.length,
    nextOffset: nextOffset < candidates.length ? nextOffset : undefined,
    hasMore: nextOffset < candidates.length,
  };
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return Number((dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))).toFixed(6));
}

function cloneResult(result: LexicalVaultQaResult): LexicalVaultQaResult {
  return {
    ...result,
    signals: [...result.signals],
    snippets: [...result.snippets],
  };
}

function compareHybridResults(left: LexicalVaultQaResult, right: LexicalVaultQaResult): number {
  if (right.score !== left.score) return right.score - left.score;
  const rightTime = right.document.modifiedTime ?? 0;
  const leftTime = left.document.modifiedTime ?? 0;
  if (rightTime !== leftTime) return rightTime - leftTime;
  return left.document.path.localeCompare(right.document.path);
}
