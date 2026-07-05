import { describe, expect, it } from "vitest";
import {
  buildRetrievalLanguagePolicy,
  createScopedIndexState,
  DEFAULT_RETRIEVAL_SIGNALS,
  estimateEmbeddingIndexCost,
  formatRetrievalIndexStatus,
  normalizeLanguageCode,
  type EmbeddingModelProfile,
  type RetrievalIndexScope,
} from "../src/retrieval/policy";
import {
  DeterministicFakeEmbedder,
  FAKE_EMBEDDING_PROFILE,
  MULTILINGUAL_RETRIEVAL_FIXTURE,
} from "./helpers/retrieval-fixtures";

const folderScope: RetrievalIndexScope = {
  kind: "folder",
  label: "Projects",
  paths: ["Projects"],
};

describe("retrieval signal policy", () => {
  it("keeps semantic retrieval optional while lexical and graph signals work without an index", () => {
    const semantic = DEFAULT_RETRIEVAL_SIGNALS.find((signal) => signal.kind === "semantic");
    const nonIndexedSignals = DEFAULT_RETRIEVAL_SIGNALS.filter((signal) => !signal.requiresIndex);

    expect(semantic).toMatchObject({ source: "semantic", requiresIndex: true });
    expect(nonIndexedSignals.map((signal) => signal.kind)).toEqual([
      "path",
      "title",
      "body",
      "tag",
      "frontmatter",
      "alias",
      "link",
      "backlink",
      "recency",
      "active-note",
    ]);
  });
});

describe("DeterministicFakeEmbedder", () => {
  it("returns stable vectors without a live embedding provider", async () => {
    const embedder = new DeterministicFakeEmbedder();
    const first = await embedder.embed({ id: "a", text: "Hybrid retrieval", language: "en" });
    const second = await embedder.embed({ id: "b", text: "  hybrid   retrieval  ", language: "en" });

    expect(first.modelId).toBe(FAKE_EMBEDDING_PROFILE.id);
    expect(first.dimensions).toBe(FAKE_EMBEDDING_PROFILE.dimensions);
    expect(first.values).toHaveLength(FAKE_EMBEDDING_PROFILE.dimensions);
    expect(second.values).toEqual(first.values);
  });

  it("embeds a tiny multilingual fixture vault in deterministic batches", async () => {
    const embedder = new DeterministicFakeEmbedder();
    const embeddings = await embedder.embedBatch(
      MULTILINGUAL_RETRIEVAL_FIXTURE.map((document) => ({
        id: document.id,
        text: document.content,
        language: normalizeLanguageCode(document.language),
      })),
    );

    expect(embeddings).toHaveLength(3);
    expect(new Set(embeddings.map((embedding) => embedding.language))).toEqual(new Set(["en", "hu"]));
    expect(embeddings[0]?.values).not.toEqual(embeddings[1]?.values);
  });
});

describe("retrieval language policy", () => {
  it("normalizes language metadata to primary ISO-like codes", () => {
    expect(normalizeLanguageCode("en-US")).toBe("en");
    expect(normalizeLanguageCode("hu_HU")).toBe("hu");
    expect(normalizeLanguageCode("")).toBeUndefined();
    expect(normalizeLanguageCode("english")).toBeUndefined();
  });

  it("treats same-language lexical retrieval as reliable without embeddings", () => {
    const policy = buildRetrievalLanguagePolicy({
      queryLanguage: "en-US",
      documentLanguages: ["en", "en-GB"],
    });

    expect(policy).toMatchObject({
      queryLanguage: "en",
      documentLanguages: ["en"],
      mode: "same-language",
      lexicalReliable: true,
      semanticRecommended: false,
      multilingualEmbeddingsRequired: false,
    });
    expect(policy.limitationMessages).toEqual([]);
  });

  it("surfaces a limitation message when cross-language retrieval has no semantic support", () => {
    const policy = buildRetrievalLanguagePolicy({
      queryLanguage: "hu",
      documentLanguages: ["en", "hu"],
      hasMultilingualEmbeddings: false,
    });

    expect(policy.mode).toBe("cross-language-limited");
    expect(policy.lexicalReliable).toBe(false);
    expect(policy.semanticRecommended).toBe(true);
    expect(policy.multilingualEmbeddingsRequired).toBe(true);
    expect(policy.limitationMessages).toEqual([
      "Cross-language retrieval is limited without multilingual embeddings or query expansion.",
    ]);
  });

  it("distinguishes multilingual embeddings from query expansion", () => {
    expect(
      buildRetrievalLanguagePolicy({
        queryLanguage: "hu",
        documentLanguages: ["en"],
        hasMultilingualEmbeddings: true,
      }).mode,
    ).toBe("cross-language-semantic");

    expect(
      buildRetrievalLanguagePolicy({
        queryLanguage: "hu",
        documentLanguages: ["en"],
        hasQueryExpansion: true,
      }).mode,
    ).toBe("cross-language-expanded");
  });
});

describe("embedding indexing estimates", () => {
  it("estimates remote embedding token cost and batch count", () => {
    const remoteModel: EmbeddingModelProfile = {
      id: "remote/multilingual",
      provider: "OpenRouter",
      dimensions: 1536,
      execution: "remote",
      languageCoverage: "multilingual",
      pricePerMillionTokensUsd: 0.02,
    };

    const estimate = estimateEmbeddingIndexCost({
      scope: folderScope,
      model: remoteModel,
      documentCount: 130,
      characterCount: 40_000,
      indexingBatchSize: 50,
    });

    expect(estimate).toMatchObject({
      modelId: "remote/multilingual",
      estimatedTokens: 10_000,
      estimatedBatches: 3,
      estimatedCostUsd: 0.0002,
      requiresNetwork: true,
      likelySlowWithoutGpu: false,
      warnings: [],
    });
  });

  it("warns for full-vault local CPU indexes and non-multilingual models", () => {
    const localModel: EmbeddingModelProfile = {
      id: "local/cpu-english",
      provider: "Ollama",
      dimensions: 768,
      execution: "local-cpu",
      languageCoverage: "monolingual",
      requiresNetwork: false,
    };

    const estimate = estimateEmbeddingIndexCost({
      scope: { kind: "vault", label: "Whole vault" },
      model: localModel,
      documentCount: 1200,
      characterCount: 250_000,
    });

    expect(estimate.estimatedCostUsd).toBeUndefined();
    expect(estimate.requiresNetwork).toBe(false);
    expect(estimate.likelySlowWithoutGpu).toBe(true);
    expect(estimate.warnings).toEqual([
      "Full-vault indexing can be expensive; prefer a scoped index first.",
      "Local CPU embedding may be slow without GPU acceleration.",
      "Model is not marked multilingual; cross-language retrieval may be limited.",
    ]);
  });
});

describe("scoped indexing status", () => {
  it("creates a not-started state for a scoped index", () => {
    const state = createScopedIndexState({ scope: folderScope });

    expect(state).toMatchObject({
      scope: folderScope,
      status: { state: "not-started", scope: folderScope },
      indexedDocumentIds: [],
    });
    expect(formatRetrievalIndexStatus(state.status)).toBe('Indexing has not started for folder "Projects".');
  });

  it("formats skipped, paused, and cancelled states clearly", () => {
    expect(
      formatRetrievalIndexStatus({
        state: "skipped",
        scope: folderScope,
        reason: "too-expensive",
      }),
    ).toBe('Indexing skipped for folder "Projects": estimated cost is too high.');

    expect(
      formatRetrievalIndexStatus({
        state: "paused",
        scope: folderScope,
        processedDocuments: 5,
        totalDocuments: 20,
        reason: "battery saver is active",
      }),
    ).toBe('Indexing paused for folder "Projects" at 5/20 documents (25%): battery saver is active.');

    expect(
      formatRetrievalIndexStatus({
        state: "cancelled",
        scope: folderScope,
        processedDocuments: 8,
        totalDocuments: 20,
        reason: "user cancelled",
      }),
    ).toBe('Indexing cancelled for folder "Projects" after 8/20 documents (40%): user cancelled.');
  });
});
