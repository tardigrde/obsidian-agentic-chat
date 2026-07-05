export type RetrievalSignalKind =
  | "path"
  | "title"
  | "body"
  | "tag"
  | "frontmatter"
  | "alias"
  | "link"
  | "backlink"
  | "recency"
  | "active-note"
  | "semantic";

export type RetrievalSignalSource = "lexical" | "metadata" | "graph" | "temporal" | "scope" | "semantic";

export interface RetrievalSignalDefinition {
  kind: RetrievalSignalKind;
  source: RetrievalSignalSource;
  defaultWeight: number;
  requiresIndex: boolean;
  description: string;
}

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

export const DEFAULT_RETRIEVAL_SIGNALS: readonly RetrievalSignalDefinition[] = [
  {
    kind: "path",
    source: "lexical",
    defaultWeight: 1.4,
    requiresIndex: false,
    description: "Vault-relative path or folder match.",
  },
  {
    kind: "title",
    source: "lexical",
    defaultWeight: 1.8,
    requiresIndex: false,
    description: "Note title or basename match.",
  },
  {
    kind: "body",
    source: "lexical",
    defaultWeight: 1,
    requiresIndex: false,
    description: "Body text match.",
  },
  {
    kind: "tag",
    source: "metadata",
    defaultWeight: 1.3,
    requiresIndex: false,
    description: "Tag match.",
  },
  {
    kind: "frontmatter",
    source: "metadata",
    defaultWeight: 1.2,
    requiresIndex: false,
    description: "Frontmatter property match.",
  },
  {
    kind: "alias",
    source: "metadata",
    defaultWeight: 1.5,
    requiresIndex: false,
    description: "Alias match.",
  },
  {
    kind: "link",
    source: "graph",
    defaultWeight: 1.1,
    requiresIndex: false,
    description: "Outgoing link proximity.",
  },
  {
    kind: "backlink",
    source: "graph",
    defaultWeight: 1.1,
    requiresIndex: false,
    description: "Incoming backlink proximity.",
  },
  {
    kind: "recency",
    source: "temporal",
    defaultWeight: 0.6,
    requiresIndex: false,
    description: "Recently modified note boost.",
  },
  {
    kind: "active-note",
    source: "scope",
    defaultWeight: 1.6,
    requiresIndex: false,
    description: "Current note or current workspace scope boost.",
  },
  {
    kind: "semantic",
    source: "semantic",
    defaultWeight: 2,
    requiresIndex: true,
    description: "Embedding similarity or semantic rerank signal.",
  },
];

export type RetrievalLanguageMode =
  | "unknown"
  | "same-language"
  | "cross-language-limited"
  | "cross-language-expanded"
  | "cross-language-semantic";

export interface RetrievalLanguagePolicyInput {
  queryLanguage?: string | null;
  documentLanguages: readonly (string | null | undefined)[];
  hasMultilingualEmbeddings?: boolean;
  hasQueryExpansion?: boolean;
}

export interface RetrievalLanguagePolicy {
  queryLanguage?: string;
  documentLanguages: readonly string[];
  mode: RetrievalLanguageMode;
  lexicalReliable: boolean;
  semanticRecommended: boolean;
  multilingualEmbeddingsRequired: boolean;
  limitationMessages: readonly string[];
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

export type RetrievalIndexScopeKind = "active-note" | "folder" | "tag" | "project" | "vault";

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
  | { state: "paused"; scope: RetrievalIndexScope; processedDocuments: number; totalDocuments: number; reason: string }
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

export function buildRetrievalLanguagePolicy(input: RetrievalLanguagePolicyInput): RetrievalLanguagePolicy {
  const queryLanguage = normalizeLanguageCode(input.queryLanguage);
  const documentLanguages = uniqueLanguages(input.documentLanguages);
  const limitationMessages: string[] = [];

  if (!queryLanguage || documentLanguages.length === 0) {
    limitationMessages.push("Language metadata is incomplete; retrieval quality should be described as unknown.");
    return {
      queryLanguage,
      documentLanguages,
      mode: "unknown",
      lexicalReliable: false,
      semanticRecommended: false,
      multilingualEmbeddingsRequired: false,
      limitationMessages,
    };
  }

  const crossesLanguages = documentLanguages.some((language) => language !== queryLanguage);
  if (!crossesLanguages) {
    return {
      queryLanguage,
      documentLanguages,
      mode: "same-language",
      lexicalReliable: true,
      semanticRecommended: false,
      multilingualEmbeddingsRequired: false,
      limitationMessages,
    };
  }

  if (input.hasMultilingualEmbeddings) {
    limitationMessages.push(
      "Cross-language retrieval can use multilingual embeddings; lexical matches may still miss translated concepts.",
    );
    return {
      queryLanguage,
      documentLanguages,
      mode: "cross-language-semantic",
      lexicalReliable: false,
      semanticRecommended: true,
      multilingualEmbeddingsRequired: false,
      limitationMessages,
    };
  }

  if (input.hasQueryExpansion) {
    limitationMessages.push(
      "Cross-language retrieval can use query expansion, but results should explain that translation quality affects recall.",
    );
    return {
      queryLanguage,
      documentLanguages,
      mode: "cross-language-expanded",
      lexicalReliable: false,
      semanticRecommended: true,
      multilingualEmbeddingsRequired: false,
      limitationMessages,
    };
  }

  limitationMessages.push("Cross-language retrieval is limited without multilingual embeddings or query expansion.");
  return {
    queryLanguage,
    documentLanguages,
    mode: "cross-language-limited",
    lexicalReliable: false,
    semanticRecommended: true,
    multilingualEmbeddingsRequired: true,
    limitationMessages,
  };
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
    case "paused":
      return `Indexing paused for ${scope} at ${formatProgress(status.processedDocuments, status.totalDocuments)}: ${status.reason}.`;
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

function uniqueLanguages(values: readonly (string | null | undefined)[]): readonly string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeLanguageCode(value);
    if (normalized) seen.add(normalized);
  }
  return [...seen].sort();
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
