import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  OPENROUTER_BASE_URL,
  buildOpenRouterRouting,
  type PrivacySettings,
} from "../llm/models";
import type { WebFetcher } from "../tools/web-fetch";
import {
  normalizeLanguageCode,
  type EmbeddingInput,
  type EmbeddingLanguageCoverage,
  type EmbeddingModelProfile,
  type EmbeddingRequestOptions,
  type EmbeddingResult,
  type RetrievalDocument,
  type RetrievalEmbedder,
  type RetrievalIndexScope,
} from "./policy";
import { stableTextHash } from "./source-hash";

export type EmbeddingProviderId = "openrouter" | "ollama" | "openai-compatible";

export interface EmbeddingSettings {
  enabled: boolean;
  provider: EmbeddingProviderId;
  openrouterModel: string;
  ollamaModel: string;
  openaiCompatibleModel: string;
  dimensions: number;
  languageCoverage: EmbeddingLanguageCoverage;
  batchSize: number;
  maxDocumentChars: number;
}

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
  languageCoverage?: EmbeddingLanguageCoverage;
  batchSize?: number;
  maxDocumentChars?: number;
  pricePerMillionTokensUsd?: number;
  privacy?: PrivacySettings;
}

export interface EmbeddingIndexRecord {
  documentId: string;
  path: string;
  modelId: string;
  dimensions: number;
  language?: string;
  contentHash: string;
  updatedAt: number;
  vector: readonly number[];
}

export interface EmbeddingIndexSnapshot {
  version: 1;
  scope: RetrievalIndexScope;
  model: EmbeddingModelProfile;
  createdAt: number;
  updatedAt: number;
  records: readonly EmbeddingIndexRecord[];
}

export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
export const DEFAULT_OPENAI_COMPATIBLE_EMBEDDING_MODEL = "";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
export const DEFAULT_EMBEDDING_MAX_DOCUMENT_CHARS = 12_000;
export const EMBEDDING_INDEX_VERSION = 1;

export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
  enabled: false,
  provider: "openrouter",
  openrouterModel: DEFAULT_OPENROUTER_EMBEDDING_MODEL,
  ollamaModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
  openaiCompatibleModel: DEFAULT_OPENAI_COMPATIBLE_EMBEDDING_MODEL,
  dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
  languageCoverage: "multilingual",
  batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
  maxDocumentChars: DEFAULT_EMBEDDING_MAX_DOCUMENT_CHARS,
};

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

export function healEmbeddingSettings(stored: Partial<EmbeddingSettings> | null | undefined): EmbeddingSettings {
  return {
    enabled: stored?.enabled === true,
    provider: healEmbeddingProvider(stored?.provider),
    openrouterModel: stringSetting(stored?.openrouterModel, DEFAULT_OPENROUTER_EMBEDDING_MODEL),
    ollamaModel: stringSetting(stored?.ollamaModel, DEFAULT_OLLAMA_EMBEDDING_MODEL),
    openaiCompatibleModel: stringSetting(
      stored?.openaiCompatibleModel,
      DEFAULT_OPENAI_COMPATIBLE_EMBEDDING_MODEL,
      true,
    ),
    dimensions: positiveInteger(stored?.dimensions, DEFAULT_EMBEDDING_DIMENSIONS, 16, 16_384),
    languageCoverage: healLanguageCoverage(stored?.languageCoverage),
    batchSize: positiveInteger(stored?.batchSize, DEFAULT_EMBEDDING_BATCH_SIZE, 1, 256),
    maxDocumentChars: positiveInteger(
      stored?.maxDocumentChars,
      DEFAULT_EMBEDDING_MAX_DOCUMENT_CHARS,
      500,
      200_000,
    ),
  };
}

export function activeEmbeddingModel(settings: EmbeddingSettings): string {
  if (settings.provider === "ollama") return settings.ollamaModel;
  if (settings.provider === "openai-compatible") return settings.openaiCompatibleModel;
  return settings.openrouterModel;
}

export function embeddingConfigFromSettings(
  settings: EmbeddingSettings,
  context: {
    openrouterApiKey?: string;
    openaiCompatibleApiKey?: string;
    ollamaBaseUrl?: string;
    openaiCompatibleBaseUrl?: string;
    privacy?: PrivacySettings;
  },
): EmbeddingProviderConfig {
  return {
    provider: settings.provider,
    model: activeEmbeddingModel(settings),
    apiKey:
      settings.provider === "openrouter"
        ? context.openrouterApiKey
        : settings.provider === "openai-compatible"
          ? context.openaiCompatibleApiKey
          : undefined,
    baseUrl:
      settings.provider === "ollama"
        ? context.ollamaBaseUrl
        : settings.provider === "openai-compatible"
          ? context.openaiCompatibleBaseUrl
          : undefined,
    dimensions: settings.dimensions,
    languageCoverage: settings.languageCoverage,
    batchSize: settings.batchSize,
    maxDocumentChars: settings.maxDocumentChars,
    privacy: context.privacy,
  };
}

export function embeddingProfileFromConfig(config: EmbeddingProviderConfig): EmbeddingModelProfile {
  const model = config.model.trim();
  const baseUrl = normalizedEmbeddingBaseUrl(config);
  return {
    id: model,
    provider: providerLabel(config.provider),
    dimensions: config.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
    execution: config.provider === "ollama" || isLocalBaseUrl(baseUrl) ? "local-cpu" : "remote",
    languageCoverage: config.languageCoverage ?? "unknown",
    pricePerMillionTokensUsd: config.pricePerMillionTokensUsd,
    requiresNetwork: config.provider === "openrouter" || !isLocalBaseUrl(baseUrl),
  };
}

export class OpenAICompatibleEmbeddingProvider implements RetrievalEmbedder {
  readonly profile: EmbeddingModelProfile;
  private readonly batchSize: number;
  private readonly maxDocumentChars: number;

  constructor(
    private readonly config: EmbeddingProviderConfig,
    private readonly fetcher: WebFetcher,
  ) {
    const model = config.model.trim();
    if (!model) throw new EmbeddingProviderError("Embedding model id is required.");
    this.config = { ...config, model };
    this.profile = embeddingProfileFromConfig(this.config);
    this.batchSize = positiveInteger(config.batchSize, DEFAULT_EMBEDDING_BATCH_SIZE, 1, 256);
    this.maxDocumentChars = positiveInteger(
      config.maxDocumentChars,
      DEFAULT_EMBEDDING_MAX_DOCUMENT_CHARS,
      500,
      200_000,
    );
  }

  async embed(input: EmbeddingInput, options?: EmbeddingRequestOptions): Promise<EmbeddingResult> {
    return (await this.embedBatch([input], options))[0];
  }

  async embedBatch(inputs: readonly EmbeddingInput[], options?: EmbeddingRequestOptions): Promise<EmbeddingResult[]> {
    throwIfAborted(options?.signal);
    if (inputs.length === 0) return [];
    const results: EmbeddingResult[] = [];
    const batchSize = positiveInteger(options?.batchSize, this.batchSize, 1, 256);
    for (let index = 0; index < inputs.length; index += batchSize) {
      throwIfAborted(options?.signal);
      const batch = inputs.slice(index, index + batchSize);
      results.push(...(await this.requestBatch(batch, options?.signal)));
    }
    return results;
  }

  private async requestBatch(inputs: readonly EmbeddingInput[], signal?: AbortSignal): Promise<EmbeddingResult[]> {
    const apiKey = this.config.apiKey?.trim();
    if (this.profile.requiresNetwork && !apiKey) {
      throw new EmbeddingProviderError(`No API key configured for ${this.profile.provider} embeddings.`);
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const payload: Record<string, unknown> = {
      model: this.profile.id,
      input: inputs.map((input) => truncateEmbeddingText(input.text, this.maxDocumentChars)),
      encoding_format: "float",
    };
    if (this.config.provider === "openrouter" && this.config.privacy) {
      payload.provider = buildOpenRouterRouting(this.config.privacy);
    }

    const response = await this.fetcher(
      {
        url: `${normalizedEmbeddingBaseUrl(this.config)}/embeddings`,
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
      signal,
    );
    throwIfAborted(signal);
    if (response.status < 200 || response.status >= 300) {
      throw new EmbeddingProviderError(
        `Embedding request failed (${response.status || "network error"}): ${response.text || "empty response"}.`,
        response.status,
      );
    }
    return parseEmbeddingResponse(response.text, this.profile, inputs);
  }
}

export function buildEmbeddingInputs(
  documents: readonly RetrievalDocument[],
  options: { maxDocumentChars?: number } = {},
): EmbeddingInput[] {
  const maxChars = positiveInteger(options.maxDocumentChars, DEFAULT_EMBEDDING_MAX_DOCUMENT_CHARS, 500, 200_000);
  return documents.map((document) => ({
    id: document.id,
    text: truncateEmbeddingText(`${document.title}\n${document.path}\n${document.content}`, maxChars),
    language: normalizeLanguageCode(document.language),
  }));
}

export async function createEmbeddingIndexRecords(
  documents: readonly RetrievalDocument[],
  embeddings: readonly EmbeddingResult[],
  options: { now?: number } = {},
): Promise<EmbeddingIndexRecord[]> {
  const byId = new Map(embeddings.map((embedding) => [embedding.inputId, embedding]));
  const updatedAt = options.now ?? Date.now();
  return Promise.all(
    documents.map(async (document) => {
      const embedding = byId.get(document.id);
      if (!embedding) throw new Error(`Missing embedding result for document "${document.id}".`);
      return {
        documentId: document.id,
        path: document.path,
        modelId: embedding.modelId,
        dimensions: embedding.dimensions,
        language: normalizeLanguageCode(document.language),
        contentHash: await embeddingDocumentFingerprint(document),
        updatedAt,
        vector: validateVector(embedding.values, embedding.dimensions),
      };
    }),
  );
}

export function createEmbeddingIndexSnapshot(input: {
  scope: RetrievalIndexScope;
  model: EmbeddingModelProfile;
  records?: readonly EmbeddingIndexRecord[];
  now?: number;
}): EmbeddingIndexSnapshot {
  const now = input.now ?? Date.now();
  const records = (input.records ?? []).map((record) => validateIndexRecord(record, input.model));
  return {
    version: EMBEDDING_INDEX_VERSION,
    scope: input.scope,
    model: input.model,
    createdAt: now,
    updatedAt: now,
    records,
  };
}

export function upsertEmbeddingIndexRecords(
  snapshot: EmbeddingIndexSnapshot,
  records: readonly EmbeddingIndexRecord[],
  options: { now?: number } = {},
): EmbeddingIndexSnapshot {
  const byId = new Map(snapshot.records.map((record) => [record.documentId, record]));
  for (const record of records) byId.set(record.documentId, validateIndexRecord(record, snapshot.model));
  return {
    ...snapshot,
    updatedAt: options.now ?? Date.now(),
    records: [...byId.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function removeEmbeddingIndexRecords(
  snapshot: EmbeddingIndexSnapshot,
  documentIds: readonly string[],
  options: { now?: number } = {},
): EmbeddingIndexSnapshot {
  const remove = new Set(documentIds);
  return {
    ...snapshot,
    updatedAt: options.now ?? Date.now(),
    records: snapshot.records.filter((record) => !remove.has(record.documentId)),
  };
}

export function embeddingDocumentFingerprint(document: RetrievalDocument): Promise<string> {
  return stableTextHash(
    JSON.stringify({
      path: document.path,
      title: document.title,
      content: document.content,
      language: normalizeLanguageCode(document.language),
      tags: document.tags ?? [],
      aliases: document.aliases ?? [],
      frontmatter: document.frontmatter ?? {},
      links: document.links ?? [],
      backlinks: document.backlinks ?? [],
      modifiedTime: document.modifiedTime ?? 0,
    }),
  );
}

function parseEmbeddingResponse(
  text: string,
  profile: EmbeddingModelProfile,
  inputs: readonly EmbeddingInput[],
): EmbeddingResult[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new EmbeddingProviderError("Embedding provider returned a non-JSON response.");
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new EmbeddingProviderError("Embedding provider returned an invalid embeddings payload.");
  }
  const rows = payload.data
    .map((row, fallbackIndex) => parseEmbeddingRow(row, fallbackIndex))
    .sort((a, b) => a.index - b.index);
  if (rows.length !== inputs.length) {
    throw new EmbeddingProviderError(`Embedding provider returned ${rows.length} vectors for ${inputs.length} inputs.`);
  }
  return rows.map((row, index) => {
    const vector = validateVector(row.embedding, profile.dimensions);
    return {
      inputId: inputs[index].id,
      modelId: profile.id,
      dimensions: profile.dimensions,
      values: vector,
      language: normalizeLanguageCode(inputs[index].language),
    };
  });
}

function parseEmbeddingRow(value: unknown, fallbackIndex: number): { index: number; embedding: readonly number[] } {
  if (!isRecord(value) || !Array.isArray(value.embedding)) {
    throw new EmbeddingProviderError("Embedding provider returned a row without an embedding vector.");
  }
  const index = typeof value.index === "number" && Number.isInteger(value.index) ? value.index : fallbackIndex;
  const embedding = value.embedding.map((item) => {
    if (typeof item !== "number") throw new EmbeddingProviderError("Embedding vector contains non-number values.");
    return item;
  });
  return { index, embedding };
}

function validateIndexRecord(record: EmbeddingIndexRecord, model: EmbeddingModelProfile): EmbeddingIndexRecord {
  if (record.modelId !== model.id) {
    throw new Error(`Embedding record model "${record.modelId}" does not match index model "${model.id}".`);
  }
  if (record.dimensions !== model.dimensions) {
    throw new Error(`Embedding record dimensions ${record.dimensions} do not match model dimensions ${model.dimensions}.`);
  }
  return { ...record, vector: validateVector(record.vector, model.dimensions) };
}

function validateVector(values: readonly number[], dimensions: number): readonly number[] {
  if (values.length !== dimensions) {
    throw new EmbeddingProviderError(`Embedding vector has ${values.length} dimensions; expected ${dimensions}.`);
  }
  if (!values.every((value) => Number.isFinite(value))) {
    throw new EmbeddingProviderError("Embedding vector contains non-finite values.");
  }
  return [...values];
}

function normalizedEmbeddingBaseUrl(config: Pick<EmbeddingProviderConfig, "provider" | "baseUrl">): string {
  if (config.provider === "openrouter") return OPENROUTER_BASE_URL;
  if (config.provider === "ollama") return `${normalizeBaseUrl(config.baseUrl, DEFAULT_OLLAMA_BASE_URL)}/v1`;
  return normalizeBaseUrl(config.baseUrl, DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
}

function providerLabel(provider: EmbeddingProviderId): string {
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "ollama") return "Ollama";
  return "OpenAI-compatible";
}

function truncateEmbeddingText(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new EmbeddingProviderError("Embedding request was cancelled.");
}

function healEmbeddingProvider(value: unknown): EmbeddingProviderId {
  return value === "openrouter" || value === "ollama" || value === "openai-compatible" ? value : "openrouter";
}

function healLanguageCoverage(value: unknown): EmbeddingLanguageCoverage {
  return value === "monolingual" || value === "multilingual" || value === "unknown" ? value : "multilingual";
}

function stringSetting(value: unknown, fallback: string, allowEmpty = false): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || allowEmpty ? trimmed : fallback;
}

function positiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/+$/, "");
}

function isLocalBaseUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
