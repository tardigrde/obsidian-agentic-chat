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

function bootstrapFor(
  adapter: MemoryAdapter,
  path: string,
  options: {
    leases?: SemanticIndexLeaseRegistry;
    embedder?: RetrievalEmbedder;
    documents?: readonly RetrievalDocument[];
    batchSize?: number;
  } = {},
) {
  return bootstrapSemanticIndex({
    adapter: adapter.asDataAdapter(),
    path,
    scope,
    documents: options.documents ?? MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, 1),
    embedder: options.embedder ?? new DeterministicFakeEmbedder(),
    batchSize: options.batchSize ?? 1,
    leases: options.leases,
  });
}

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

describe("writer-owned semantic index lease", () => {
  it("blocks a direct bootstrap call while another registry owns the path", async () => {
    const adapter = new MemoryAdapter();
    const path = "semantic/direct-lease/index.json";
    const owner = new SemanticIndexLeaseRegistry();
    const lease = await owner.acquireDurable(path);
    expect(lease).not.toBeNull();

    try {
      const blocked = await bootstrapFor(adapter, path, { leases: owner });
      expect(blocked.leaseFailure).toMatchObject({ reason: "held", heldForMs: expect.any(Number) });
      expect(blocked.file).toBeNull();
      expect(blocked.completed).toBe(false);
      expect(adapter.files.has(path)).toBe(false);
    } finally {
      await lease!.release();
    }

    const completed = await bootstrapFor(adapter, path, { leases: owner });
    expect(completed.leaseFailure).toBeUndefined();
    expect(completed.completed).toBe(true);
    expect(completed.file?.state.status.state).toBe("complete");
    expect(adapter.files.has(path)).toBe(true);
  });

  it("renews the lease after each persisted batch", async () => {
    const adapter = new MemoryAdapter();
    const path = "semantic/renewed/index.json";
    let now = 1_000;
    const leases = new SemanticIndexLeaseRegistry(() => now, 10_000);
    const embedder = new DeterministicFakeEmbedder();
    const original = embedder.embedBatch.bind(embedder);
    embedder.embedBatch = async (inputs, options) => {
      now += 8_000;
      return await original(inputs, options);
    };

    const result = await bootstrapFor(adapter, path, {
      leases,
      embedder,
      documents: MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, 3),
    });

    expect(result.completed).toBe(true);
    expect(result.file?.state.status.state).toBe("complete");
  });

  it("stops writing when a stalled run loses the lease", async () => {
    const adapter = new MemoryAdapter();
    const path = "semantic/stalled/index.json";
    let now = 1_000;
    const leases = new SemanticIndexLeaseRegistry(() => now, 60_000);
    const embedder = new DeterministicFakeEmbedder();
    const original = embedder.embedBatch.bind(embedder);
    let competing: SemanticIndexLease | null = null;
    embedder.embedBatch = async (inputs, options) => {
      const result = await original(inputs, options);
      now += 61_000;
      competing = leases.acquire(path);
      await adapter.write(path, "new-writer");
      return result;
    };

    const result = await bootstrapFor(adapter, path, { leases, embedder });
    try {
      expect(competing).not.toBeNull();
      expect(result.completed).toBe(false);
      // The stalled writer must not overwrite the new owner's file.
      expect(adapter.files.get(path)).toBe("new-writer");
    } finally {
      void (competing as SemanticIndexLease | null)?.release();
    }
  });

  it("stops writing when a lease renewal loses the shared store", async () => {
    let renewed = true;
    const store = {
      async tryAcquire() {
        return renewed;
      },
      async release() {
        // no-op
      },
    };
    const leases = new SemanticIndexLeaseRegistry(() => 1_000, 60_000, store);
    const adapter = new MemoryAdapter();
    const path = "semantic/renewal-store/index.json";
    const embedder = new DeterministicFakeEmbedder();
    const original = embedder.embedBatch.bind(embedder);
    embedder.embedBatch = async (inputs, options) => {
      renewed = false;
      return await original(inputs, options);
    };

    const result = await bootstrapFor(adapter, path, {
      leases,
      embedder,
      documents: MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, 2),
    });

    expect(result.completed).toBe(false);
    const persisted = JSON.parse(adapter.files.get(path) ?? "{}") as {
      state: { status: { state: string } };
    };
    expect(persisted.state.status.state).not.toBe("complete");
  });

  it("fails closed when the shared lease store is unavailable", async () => {
    const adapter = new MemoryAdapter();
    const path = "semantic/store-down/index.json";
    const leases = new SemanticIndexLeaseRegistry(() => 1_000, 60_000, {
      async tryAcquire() {
        throw new Error("store down");
      },
      async release() {
        // no-op
      },
    });

    const result = await bootstrapFor(adapter, path, { leases });

    expect(result.leaseFailure).toMatchObject({ reason: "store-error" });
    if (result.leaseFailure?.reason !== "store-error") throw new Error("expected a store error");
    expect(result.leaseFailure.message).toMatch(/shared semantic index lease/i);
    expect(result.file).toBeNull();
    expect(adapter.files.has(path)).toBe(false);

    // The failed attempt must free the local lease for the next writer.
    const retry = leases.acquire(path);
    expect(retry).not.toBeNull();
    void retry?.release();
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
