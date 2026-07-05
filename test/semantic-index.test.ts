import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "./helpers/memory-adapter";
import { DeterministicFakeEmbedder, MULTILINGUAL_RETRIEVAL_FIXTURE } from "./helpers/retrieval-fixtures";
import {
  bootstrapSemanticIndex,
  readSemanticIndexFile,
  semanticIndexPath,
} from "../src/retrieval/semantic-index";

const scope = { kind: "folder" as const, label: "Projects", paths: ["Projects"] };

describe("semantic index bootstrap", () => {
  it("persists progress and a complete scoped semantic index", async () => {
    const adapter = new MemoryAdapter();
    let now = 1_000;
    const path = semanticIndexPath(".obsidian/plugins/agentic-chat");
    const result = await bootstrapSemanticIndex({
      adapter: adapter.asDataAdapter(),
      path,
      scope,
      documents: MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, 2),
      embedder: new DeterministicFakeEmbedder(),
      batchSize: 1,
      now: () => now++,
    });
    const stored = await readSemanticIndexFile(adapter.asDataAdapter(), path);

    expect(result.completed).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(stored?.state.status).toMatchObject({ state: "complete", totalDocuments: 2 });
    expect(stored?.state.indexedDocumentIds).toEqual(["hu-agent-naplo", "en-mcp-oauth"]);
    expect(stored?.snapshot?.records).toHaveLength(2);
    expect(stored?.snapshot?.records[0]).toMatchObject({
      documentId: "hu-agent-naplo",
      modelId: "test/fake-deterministic-embedding",
      dimensions: 8,
      language: "hu",
    });
  });

  it("stores skipped state for an empty explicit scope", async () => {
    const adapter = new MemoryAdapter();
    const result = await bootstrapSemanticIndex({
      adapter: adapter.asDataAdapter(),
      path: "semantic/index.json",
      scope,
      documents: [],
      embedder: new DeterministicFakeEmbedder(),
      batchSize: 16,
      now: () => 1,
    });

    expect(result.file.state.status).toMatchObject({ state: "skipped", reason: "scope-empty" });
    expect(result.file.snapshot).toBeUndefined();
  });

  it("persists a cancellable partial index instead of throwing", async () => {
    const adapter = new MemoryAdapter();
    const controller = new AbortController();
    let calls = 0;
    const embedder = new DeterministicFakeEmbedder();
    const original = embedder.embedBatch.bind(embedder);
    embedder.embedBatch = async (inputs, options) => {
      calls += 1;
      const result = await original(inputs, options);
      controller.abort();
      return result;
    };

    const result = await bootstrapSemanticIndex({
      adapter: adapter.asDataAdapter(),
      path: "semantic/index.json",
      scope,
      documents: MULTILINGUAL_RETRIEVAL_FIXTURE,
      embedder,
      batchSize: 1,
      signal: controller.signal,
      now: () => 1,
    });

    expect(calls).toBe(1);
    expect(result.completed).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.file.state.status).toMatchObject({
      state: "cancelled",
      processedDocuments: 1,
      totalDocuments: 3,
    });
    expect(result.file.snapshot?.records).toHaveLength(1);
  });
});
