export interface RetrievalDocument {
  id: string;
  path: string;
  title: string;
  content: string;
  language?: string;
  tags?: readonly string[];
  aliases?: readonly string[];
  frontmatter?: Readonly<Record<string, string | number | boolean | readonly string[] | null>>;
  links?: readonly string[];
  backlinks?: readonly string[];
  modifiedTime?: number;
}

export type EmbeddingExecutionMode = "remote" | "local-cpu" | "local-gpu";
export type EmbeddingLanguageCoverage = "unknown" | "monolingual" | "multilingual";

export interface EmbeddingModelProfile {
  id: string;
  provider: string;
  dimensions: number;
  execution: EmbeddingExecutionMode;
  languageCoverage: EmbeddingLanguageCoverage;
  pricePerMillionTokensUsd?: number;
  requiresNetwork?: boolean;
}

export interface EmbeddingInput {
  id: string;
  text: string;
  language?: string;
}

export interface EmbeddingResult {
  inputId: string;
  modelId: string;
  dimensions: number;
  values: readonly number[];
  language?: string;
}

export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
  batchSize?: number;
}

export interface RetrievalEmbedder {
  readonly profile: EmbeddingModelProfile;
  embed(input: EmbeddingInput, options?: EmbeddingRequestOptions): Promise<EmbeddingResult>;
  embedBatch(inputs: readonly EmbeddingInput[], options?: EmbeddingRequestOptions): Promise<EmbeddingResult[]>;
}

export type RetrievalIndexScopeKind = "active-note" | "folder" | "tag" | "vault";

export interface RetrievalIndexScope {
  kind: RetrievalIndexScopeKind;
  label: string;
  paths?: readonly string[];
  tags?: readonly string[];
  includeGlobs?: readonly string[];
  excludeGlobs?: readonly string[];
}

export interface EmbeddingIndexEstimateInput {
  scope: RetrievalIndexScope;
  model: EmbeddingModelProfile;
  documentCount: number;
  characterCount: number;
  averageCharsPerToken?: number;
  indexingBatchSize?: number;
}

export interface EmbeddingIndexCostEstimate {
  scope: RetrievalIndexScope;
  modelId: string;
  documentCount: number;
  characterCount: number;
  estimatedTokens: number;
  estimatedBatches: number;
  estimatedCostUsd?: number;
  requiresNetwork: boolean;
  likelySlowWithoutGpu: boolean;
  warnings: readonly string[];
}

export type RetrievalIndexSkipReason =
  | "user-declined"
  | "too-expensive"
  | "mobile-battery"
  | "no-provider"
  | "scope-empty";

export type RetrievalIndexingStatus =
  | { state: "not-started"; scope: RetrievalIndexScope }
  | { state: "running"; scope: RetrievalIndexScope; processedDocuments: number; totalDocuments: number }
  | { state: "cancelled"; scope: RetrievalIndexScope; processedDocuments: number; totalDocuments: number; reason: string }
  | { state: "skipped"; scope: RetrievalIndexScope; reason: RetrievalIndexSkipReason; message?: string }
  | { state: "complete"; scope: RetrievalIndexScope; totalDocuments: number }
  | { state: "failed"; scope: RetrievalIndexScope; processedDocuments: number; totalDocuments: number; error: string };

export interface ScopedRetrievalIndexState {
  scope: RetrievalIndexScope;
  status: RetrievalIndexingStatus;
  estimate?: EmbeddingIndexCostEstimate;
  indexedDocumentIds: readonly string[];
}

const DEFAULT_AVERAGE_CHARS_PER_TOKEN = 4;
const DEFAULT_INDEXING_BATCH_SIZE = 64;
const LARGE_VAULT_DOCUMENT_THRESHOLD = 1000;
const LOCAL_CPU_CHARACTER_THRESHOLD = 100_000;

export function normalizeLanguageCode(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const primary = trimmed.replace("_", "-").split("-")[0]?.toLowerCase();
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

export function estimateEmbeddingIndexCost(input: EmbeddingIndexEstimateInput): EmbeddingIndexCostEstimate {
  const averageCharsPerToken = input.averageCharsPerToken ?? DEFAULT_AVERAGE_CHARS_PER_TOKEN;
  const batchSize = input.indexingBatchSize ?? DEFAULT_INDEXING_BATCH_SIZE;
  const estimatedTokens = Math.ceil(Math.max(0, input.characterCount) / averageCharsPerToken);
  const estimatedBatches = Math.ceil(Math.max(0, input.documentCount) / batchSize);
  const estimatedCostUsd =
    input.model.pricePerMillionTokensUsd === undefined
      ? undefined
      : roundUsd((estimatedTokens / 1_000_000) * input.model.pricePerMillionTokensUsd);
  const requiresNetwork = input.model.requiresNetwork ?? input.model.execution === "remote";
  const likelySlowWithoutGpu =
    input.model.execution === "local-cpu" && input.characterCount >= LOCAL_CPU_CHARACTER_THRESHOLD;
  const warnings: string[] = [];

  if (input.scope.kind === "vault" && input.documentCount >= LARGE_VAULT_DOCUMENT_THRESHOLD) {
    warnings.push("Full-vault indexing can be expensive; prefer a scoped index first.");
  }
  if (likelySlowWithoutGpu) {
    warnings.push("Local CPU embedding may be slow without GPU acceleration.");
  }
  if (input.model.languageCoverage !== "multilingual") {
    warnings.push("Model is not marked multilingual; cross-language retrieval may be limited.");
  }

  return {
    scope: input.scope,
    modelId: input.model.id,
    documentCount: input.documentCount,
    characterCount: input.characterCount,
    estimatedTokens,
    estimatedBatches,
    estimatedCostUsd,
    requiresNetwork,
    likelySlowWithoutGpu,
    warnings,
  };
}

export function createScopedIndexState(input: {
  scope: RetrievalIndexScope;
  status?: RetrievalIndexingStatus;
  estimate?: EmbeddingIndexCostEstimate;
  indexedDocumentIds?: readonly string[];
}): ScopedRetrievalIndexState {
  return {
    scope: input.scope,
    status: input.status ?? { state: "not-started", scope: input.scope },
    estimate: input.estimate,
    indexedDocumentIds: input.indexedDocumentIds ?? [],
  };
}

export function formatRetrievalIndexStatus(status: RetrievalIndexingStatus): string {
  const scope = formatScope(status.scope);
  switch (status.state) {
    case "not-started":
      return `Indexing has not started for ${scope}.`;
    case "running":
      return `Indexing ${scope}: ${formatProgress(status.processedDocuments, status.totalDocuments)}.`;
    case "cancelled":
      return `Indexing cancelled for ${scope} after ${formatProgress(status.processedDocuments, status.totalDocuments)}: ${status.reason}.`;
    case "skipped":
      return `Indexing skipped for ${scope}: ${status.message ?? skipReasonLabel(status.reason)}.`;
    case "complete":
      return `Indexing complete for ${scope}: ${status.totalDocuments} documents indexed.`;
    case "failed":
      return `Indexing failed for ${scope} at ${formatProgress(status.processedDocuments, status.totalDocuments)}: ${status.error}.`;
  }
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

function formatScope(scope: RetrievalIndexScope): string {
  return `${scope.kind} "${scope.label}"`;
}

function formatProgress(processedDocuments: number, totalDocuments: number): string {
  if (totalDocuments <= 0) return `${processedDocuments}/0 documents`;
  const percent = Math.round((processedDocuments / totalDocuments) * 100);
  return `${processedDocuments}/${totalDocuments} documents (${percent}%)`;
}

function skipReasonLabel(reason: RetrievalIndexSkipReason): string {
  switch (reason) {
    case "user-declined":
      return "user declined indexing";
    case "too-expensive":
      return "estimated cost is too high";
    case "mobile-battery":
      return "device or battery policy disallows indexing";
    case "no-provider":
      return "no embedding provider is configured";
    case "scope-empty":
      return "scope contains no indexable documents";
  }
}
