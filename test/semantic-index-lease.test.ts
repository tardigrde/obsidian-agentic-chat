import { describe, expect, it } from "vitest";
import {
  bootstrapSemanticIndex,
  semanticIndexLeases,
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
      first.release();
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
    (competing as SemanticIndexLease | null)?.release();
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
    lease?.release();
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
    lease?.release();
  });
});
