import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "./helpers/memory-adapter";
import { DeterministicFakeEmbedder, MULTILINGUAL_RETRIEVAL_FIXTURE } from "./helpers/retrieval-fixtures";
import {
  bootstrapSemanticIndex,
  readSemanticIndexFile,
  semanticIndexLeases,
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

  it("repairs a stale running state on load", async () => {
    const adapter = new MemoryAdapter();
    const path = "semantic/index.json";
    await adapter.write(
      path,
      JSON.stringify({
        version: 1,
        updatedAt: 1_000,
        state: {
          scope,
          status: { state: "running", scope, processedDocuments: 2, totalDocuments: 9 },
          indexedDocumentIds: [],
        },
      }),
    );

    const stored = await readSemanticIndexFile(adapter.asDataAdapter(), path);

    expect(stored?.state.status).toMatchObject({
      state: "failed",
      processedDocuments: 2,
      totalDocuments: 9,
    });
    if (stored?.state.status.state === "failed") {
      expect(stored.state.status.error).toMatch(/interrupted/i);
    }
    const persisted = JSON.parse(await adapter.read(path)) as {
      state: { status: { state: string } };
    };
    expect(persisted.state.status.state).toBe("failed");
  });

  it("does not repair a running index while a writer holds the lease", async () => {
    const adapter = new MemoryAdapter();
    const path = "semantic/leased/index.json";
    const running = JSON.stringify({
      version: 1,
      updatedAt: 1_000,
      state: {
        scope,
        status: { state: "running", scope, processedDocuments: 1, totalDocuments: 4 },
        indexedDocumentIds: [],
      },
    });
    const lease = semanticIndexLeases.acquire(path);
    expect(lease).not.toBeNull();
    try {
      await adapter.write(path, running);

      const during = await readSemanticIndexFile(adapter.asDataAdapter(), path);
      expect(during?.state.status.state).toBe("running");
      expect(adapter.files.get(path)).toBe(running);
    } finally {
      lease?.release();
    }

    const after = await readSemanticIndexFile(adapter.asDataAdapter(), path);
    expect(after?.state.status.state).toBe("failed");
    const persisted = JSON.parse(adapter.files.get(path) ?? "{}") as {
      state: { status: { state: string } };
    };
    expect(persisted.state.status.state).toBe("failed");
  });

  it("returns a newer index instead of overwriting it with a stale repair", async () => {
    const adapter = new MemoryAdapter();
    const path = "semantic/stale-read/index.json";
    const running = JSON.stringify({
      version: 1,
      updatedAt: 1_000,
      state: {
        scope,
        status: { state: "running", scope, processedDocuments: 1, totalDocuments: 4 },
        indexedDocumentIds: [],
      },
    });
    const complete = JSON.stringify({
      version: 1,
      updatedAt: 2_000,
      state: {
        scope,
        status: { state: "complete", scope, totalDocuments: 4 },
        indexedDocumentIds: [],
      },
    });
    await adapter.write(path, complete);
    const originalRead = adapter.read.bind(adapter);
    let reads = 0;
    adapter.read = async (target) => {
      reads += 1;
      if (target === path) return reads === 1 ? running : complete;
      return originalRead(target);
    };

    const stored = await readSemanticIndexFile(adapter.asDataAdapter(), path);

    expect(stored?.state.status.state).toBe("complete");
    expect(stored?.updatedAt).toBe(2_000);
    expect(adapter.files.get(path)).toBe(complete);
  });

  it("leases one index path and recovers an expired lease", async () => {
    const { SemanticIndexLeaseRegistry } = await import("../src/retrieval/semantic-index");
    let now = 1_000;
    const leases = new SemanticIndexLeaseRegistry(() => now, 60_000);
    const first = leases.acquire("index.json");
    expect(first).not.toBeNull();
    expect(leases.acquire("index.json")).toBeNull();

    now += 61_000;
    const recovered = leases.acquire("index.json");
    expect(recovered).not.toBeNull();
    recovered?.release();

    // The stale owner's release must not free the recovered lease.
    first?.release();
    expect(leases.acquire("index.json")).not.toBeNull();
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
