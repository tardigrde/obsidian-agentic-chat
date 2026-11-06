import { describe, expect, it } from "vitest";
import {
  bootstrapSemanticIndex,
  semanticIndexLeases,
  SemanticIndexLeaseRegistry,
  type SemanticIndexLease,
} from "../src/retrieval/semantic-index";
import type { RetrievalDocument, RetrievalEmbedder } from "../src/retrieval/policy";
import {
  SemanticIndexWorkflowController,
} from "../src/ui/semantic-index-workflow-controller";
import type { WorkflowRenderer } from "../src/ui/workflow-renderer";
import { MemoryAdapter } from "./helpers/memory-adapter";
import {
  DeterministicFakeEmbedder,
  FAKE_EMBEDDING_PROFILE,
  MULTILINGUAL_RETRIEVAL_FIXTURE,
} from "./helpers/retrieval-fixtures";

const scope = { kind: "folder" as const, label: "Projects", paths: ["Projects"] };

function controllerFor(options: {
  adapter?: MemoryAdapter;
  indexPath?: string;
  loadDocuments?: () => Promise<RetrievalDocument[]>;
  createEmbedder?: () => RetrievalEmbedder;
  renderer?: WorkflowRenderer;
}): SemanticIndexWorkflowController {
  const adapter = options.adapter ?? new MemoryAdapter();
  return new SemanticIndexWorkflowController({
    adapter: adapter.asDataAdapter(),
    indexPath: () => options.indexPath ?? "semantic/index.json",
    activeNotePath: () => "Research/Retrieval.md",
    loadDocuments: options.loadDocuments ?? (async () => [...MULTILINGUAL_RETRIEVAL_FIXTURE]),
    embeddingConfig: () => ({
      provider: "openai-compatible",
      model: FAKE_EMBEDDING_PROFILE.id,
      dimensions: FAKE_EMBEDDING_PROFILE.dimensions,
      languageCoverage: FAKE_EMBEDDING_PROFILE.languageCoverage,
      baseUrl: "http://localhost:11434/v1",
    }),
    embeddingsEnabled: () => true,
    activeEmbeddingModel: () => FAKE_EMBEDDING_PROFILE.id,
    batchSize: () => 1,
    createEmbedder: options.createEmbedder ?? (() => new DeterministicFakeEmbedder()),
    renderer: options.renderer ?? noopRenderer(),
  });
}

function noopRenderer(): WorkflowRenderer {
  return {
    clear: () => undefined,
    info: () => undefined,
    error: () => undefined,
    actionList: () => undefined,
  };
}

describe("post-216 semantic index lease ownership", () => {
  it("stops writing when another writer takes the lease during a stalled batch", async () => {
    const adapter = new MemoryAdapter();
    const data = adapter.asDataAdapter();
    const path = "semantic/lease-takeover/index.json";
    const first: SemanticIndexLease = semanticIndexLeases.acquire(path)!;
    const embedder = new DeterministicFakeEmbedder();
    const original = embedder.embedBatch.bind(embedder);
    let competing: SemanticIndexLease | null = null;
    embedder.embedBatch = async (inputs, options) => {
      const result = await original(inputs, options);
      void first.release();
      competing = semanticIndexLeases.acquire(path);
      await data.write(path, "new-writer");
      return result;
    };

    const result = await bootstrapSemanticIndex({
      adapter: data,
      path,
      scope,
      documents: MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, 1),
      embedder,
      batchSize: 1,
      isLeaseOwned: () => first.isOwned(),
    });

    expect(competing).not.toBeNull();
    expect(adapter.files.get(path)).toBe("new-writer");
    expect(result.completed).toBe(false);
    void (competing as SemanticIndexLease | null)?.release();
  });
});

describe("cross-window semantic index lease", () => {
  type FakeStore = {
    tryAcquire: (path: string, ownerId: string, now: number, ttlMs: number) => Promise<boolean>;
    release: (path: string, ownerId: string) => Promise<void>;
  };
  type DurableRegistry = SemanticIndexLeaseRegistry & {
    acquireDurable?: (path: string) => Promise<SemanticIndexLease | null>;
  };
  const Registry = SemanticIndexLeaseRegistry as unknown as new (
    now: () => number,
    ttlMs: number,
    store: FakeStore,
  ) => DurableRegistry;

  function sharedStore(): FakeStore {
    const records = new Map<string, { ownerId: string; touchedAt: number }>();
    return {
      async tryAcquire(path, ownerId, now, ttlMs) {
        const record = records.get(path);
        if (record && record.ownerId !== ownerId && now - record.touchedAt < ttlMs) return false;
        records.set(path, { ownerId, touchedAt: now });
        return true;
      },
      async release(path, ownerId) {
        if (records.get(path)?.ownerId === ownerId) records.delete(path);
      },
    };
  }

  it("blocks a second window and recovers after the first releases", async () => {
    const store = sharedStore();
    const now = 1_000;
    const first = new Registry(() => now, 60_000, store);
    const second = new Registry(() => now, 60_000, store);

    expect(first.acquireDurable, "durable lease API").toBeTypeOf("function");
    const firstLease = await first.acquireDurable!("shared/index.json");
    expect(firstLease).not.toBeNull();

    const secondLease = await second.acquireDurable!("shared/index.json");
    expect(secondLease).toBeNull();

    void firstLease!.release();
    const retry = await second.acquireDurable!("shared/index.json");
    expect(retry).not.toBeNull();
    void retry!.release();
  });

  it("stops owning the lease when a renewal loses the shared store", async () => {
    let acquired = true;
    const store: FakeStore = {
      async tryAcquire() {
        return acquired;
      },
      async release() {
        // no-op
      },
    };
    const registry = new Registry(() => 1_000, 60_000, store);

    const lease = await registry.acquireDurable!("shared/renew/index.json");
    expect(lease).not.toBeNull();
    expect(lease!.isOwned()).toBe(true);

    acquired = false;
    lease!.touch();
    await Promise.resolve();
    await Promise.resolve();
    expect(lease!.isOwned()).toBe(false);

    // The next indexing pass must not persist anything under a lost lease.
    const adapter = new MemoryAdapter();
    const result = await bootstrapSemanticIndex({
      adapter: adapter.asDataAdapter(),
      path: "shared/renew/index.json",
      scope,
      documents: MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, 1),
      embedder: new DeterministicFakeEmbedder(),
      batchSize: 1,
      isLeaseOwned: () => lease!.isOwned(),
    });
    expect(result.completed).toBe(false);
    expect(adapter.files.has("shared/renew/index.json")).toBe(false);
    void lease!.release();
  });

  it("fails closed and frees the local lease when the shared store rejects", async () => {
    const store: FakeStore = {
      async tryAcquire() {
        throw new Error("store down");
      },
      async release() {
        // no-op
      },
    };
    const registry = new Registry(() => 1_000, 60_000, store);

    await expect(registry.acquireDurable!("shared/fail/index.json")).rejects.toThrow(
      /shared semantic index lease/i,
    );

    const local = registry.acquire("shared/fail/index.json");
    expect(local).not.toBeNull();
    void local?.release();
  });

  it("recovers a crashed window after the lease TTL", async () => {
    const store = sharedStore();
    let now = 1_000;
    const first = new Registry(() => now, 60_000, store);
    const second = new Registry(() => now, 60_000, store);

    const crashed = await first.acquireDurable!("shared/crashed/index.json");
    expect(crashed).not.toBeNull();
    // No release: the window died while holding the lease.

    now = 61_001;
    const recovered = await second.acquireDurable!("shared/crashed/index.json");
    expect(recovered).not.toBeNull();
    void recovered!.release();
  });
});

describe("post-216 semantic index workflow", () => {
  it("honors cancel while documents are still being prepared", async () => {
    const adapter = new MemoryAdapter();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseDocuments!: () => void;
    const documentsGate = new Promise<void>((resolve) => {
      releaseDocuments = resolve;
    });
    const controller = controllerFor({
      adapter,
      indexPath: "semantic/cancel-prepare/index.json",
      loadDocuments: async () => {
        markStarted();
        await documentsGate;
        return [...MULTILINGUAL_RETRIEVAL_FIXTURE];
      },
    });

    const running = controller.run("start folder Projects");
    await started;
    controller.cancel();
    releaseDocuments();
    await running;

    expect(adapter.files.has("semantic/cancel-prepare/index.json")).toBe(false);
    const lease = semanticIndexLeases.acquire("semantic/cancel-prepare/index.json");
    expect(lease).not.toBeNull();
    void lease?.release();
  });

  it("releases the lease when the start renderer throws", async () => {
    const indexPath = "semantic/renderer-throw/index.json";
    const controller = controllerFor({
      indexPath,
      renderer: {
        ...noopRenderer(),
        info: () => {
          throw new Error("render failed");
        },
      },
    });

    await expect(controller.run("start folder Projects")).rejects.toThrow("render failed");

    const lease = semanticIndexLeases.acquire(indexPath);
    expect(lease).not.toBeNull();
    void lease?.release();
  });
});
