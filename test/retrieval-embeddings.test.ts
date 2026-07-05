import { describe, expect, it } from "vitest";
import type { WebFetcher, WebHttpRequest } from "../src/tools/web-fetch";
import {
  OpenAICompatibleEmbeddingProvider,
  buildEmbeddingInputs,
  createEmbeddingIndexRecords,
  createEmbeddingIndexSnapshot,
  embeddingDocumentFingerprint,
  embeddingProfileFromConfig,
  removeEmbeddingIndexRecords,
  upsertEmbeddingIndexRecords,
} from "../src/retrieval/embeddings";
import { MULTILINGUAL_RETRIEVAL_FIXTURE } from "./helpers/retrieval-fixtures";

const NOW = Date.UTC(2026, 5, 27, 12);
const folderScope = { kind: "folder" as const, label: "Projects", paths: ["Projects"] };

describe("OpenAI-compatible embedding provider", () => {
  it("batches OpenRouter embedding requests with privacy routing and no live network", async () => {
    const calls: WebHttpRequest[] = [];
    const fetcher: WebFetcher = async (request) => {
      calls.push(request);
      const input = JSON.parse(request.body ?? "{}").input as string[];
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          data: input.map((_text, index) => ({ index, embedding: [index + 0.1, index + 0.2, index + 0.3] })),
        }),
      };
    };
    const provider = new OpenAICompatibleEmbeddingProvider(
      {
        provider: "openrouter",
        model: "test/embed",
        apiKey: "secret-key",
        dimensions: 3,
        languageCoverage: "multilingual",
        batchSize: 2,
        privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: false },
      },
      fetcher,
    );

    const result = await provider.embedBatch(
      [
        { id: "a", text: "alpha", language: "en-US" },
        { id: "b", text: "beta", language: "hu-HU" },
        { id: "c", text: "gamma", language: "en" },
      ],
      { batchSize: 2 },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://openrouter.ai/api/v1/embeddings",
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
    });
    expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({
      model: "test/embed",
      input: ["alpha", "beta"],
      provider: { allow_fallbacks: false, data_collection: "deny", zdr: true },
    });
    expect(result.map((embedding) => embedding.inputId)).toEqual(["a", "b", "c"]);
    expect(result.map((embedding) => embedding.language)).toEqual(["en", "hu", "en"]);
    expect(result[0].values).toEqual([0.1, 0.2, 0.3]);
  });

  it("uses local Ollama without an API key and rejects unsafe provider responses", async () => {
    const provider = new OpenAICompatibleEmbeddingProvider(
      {
        provider: "ollama",
        model: "nomic-embed-text",
        baseUrl: "http://localhost:11434/",
        dimensions: 2,
      },
      async () => ({
        status: 200,
        headers: {},
        text: JSON.stringify({ data: [{ index: 0, embedding: [1, Number.NaN] }] }),
      }),
    );

    expect(provider.profile).toMatchObject({
      provider: "Ollama",
      execution: "local-cpu",
      requiresNetwork: false,
    });
    await expect(provider.embed({ id: "bad", text: "bad" })).rejects.toThrow(/non-number/i);
  });

  it("requires API keys for remote embedding providers and honors cancellation", async () => {
    const provider = new OpenAICompatibleEmbeddingProvider(
      {
        provider: "openai-compatible",
        model: "remote-embed",
        baseUrl: "https://gateway.example.com/v1",
        dimensions: 2,
      },
      async () => {
        throw new Error("fetcher should not be called");
      },
    );
    const controller = new AbortController();

    await expect(provider.embed({ id: "a", text: "alpha" })).rejects.toThrow(/No API key/i);
    controller.abort();
    await expect(provider.embed({ id: "a", text: "alpha" }, { signal: controller.signal })).rejects.toThrow(
      /cancelled/i,
    );
  });
});

describe("embedding index format", () => {
  it("builds bounded embedding inputs and stable SHA-256 content fingerprints", async () => {
    const inputs = buildEmbeddingInputs(MULTILINGUAL_RETRIEVAL_FIXTURE, { maxDocumentChars: 500 });

    expect(inputs[0]).toMatchObject({
      id: "en-mcp-oauth",
      language: "en",
    });
    expect(inputs[0].text).toContain("MCP OAuth plan");
    const fingerprint = await embeddingDocumentFingerprint(MULTILINGUAL_RETRIEVAL_FIXTURE[0]);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(embeddingDocumentFingerprint({ ...MULTILINGUAL_RETRIEVAL_FIXTURE[0] })).resolves.toBe(fingerprint);
  });

  it("creates, upserts, and removes validated index records", async () => {
    const model = embeddingProfileFromConfig({
      provider: "openai-compatible",
      model: "test/embed",
      baseUrl: "http://localhost:3000/api",
      dimensions: 2,
      languageCoverage: "multilingual",
    });
    const docs = MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, 2);
    const records = await createEmbeddingIndexRecords(
      docs,
      [
        { inputId: docs[0].id, modelId: model.id, dimensions: 2, values: [0.1, 0.2], language: "en" },
        { inputId: docs[1].id, modelId: model.id, dimensions: 2, values: [0.3, 0.4], language: "hu" },
      ],
      { now: NOW },
    );
    const snapshot = createEmbeddingIndexSnapshot({ scope: folderScope, model, records: [records[0]], now: NOW });
    const updated = upsertEmbeddingIndexRecords(snapshot, [records[1], { ...records[0], vector: [0.9, 0.8] }], {
      now: NOW + 1,
    });
    const pruned = removeEmbeddingIndexRecords(updated, [docs[1].id], { now: NOW + 2 });

    expect(snapshot).toMatchObject({
      version: 1,
      scope: folderScope,
      model,
      records: [records[0]],
    });
    expect(updated.records.map((record) => record.documentId)).toEqual(["hu-agent-naplo", "en-mcp-oauth"]);
    expect(updated.records.find((record) => record.documentId === "en-mcp-oauth")?.vector).toEqual([0.9, 0.8]);
    expect(pruned.records.map((record) => record.documentId)).toEqual(["en-mcp-oauth"]);
    expect(pruned.updatedAt).toBe(NOW + 2);
  });
});
