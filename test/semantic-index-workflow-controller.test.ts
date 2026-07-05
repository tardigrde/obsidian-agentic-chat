import type { DataAdapter } from "obsidian";
import { describe, expect, it } from "vitest";
import { readSemanticIndexFile } from "../src/retrieval/semantic-index";
import type {
  EmbeddingInput,
  EmbeddingRequestOptions,
  EmbeddingResult,
  RetrievalDocument,
  RetrievalEmbedder,
} from "../src/retrieval/policy";
import {
  semanticEstimateRows,
  semanticIndexRows,
  SemanticIndexWorkflowController,
} from "../src/ui/semantic-index-workflow-controller";
import type { ActionRow, WorkflowRenderer } from "../src/ui/workflow-renderer";
import { DeterministicFakeEmbedder, FAKE_EMBEDDING_PROFILE, MULTILINGUAL_RETRIEVAL_FIXTURE } from "./helpers/retrieval-fixtures";
import { MemoryAdapter } from "./helpers/memory-adapter";

const INDEX_PATH = ".obsidian/plugins/agentic-chat/semantic-index/index.json";

type RenderCall =
  | { type: "clear" }
  | { type: "info"; title: string; entries: Array<[string, string]> }
  | { type: "error"; message: string }
  | { type: "actions"; title: string; subtitle: string; items: ActionRow[] };

function renderer(calls: RenderCall[]): WorkflowRenderer {
  return {
    clear: () => calls.push({ type: "clear" }),
    info: (title, entries) => calls.push({ type: "info", title, entries }),
    error: (message) => calls.push({ type: "error", message }),
    actionList: (title, subtitle, items) => calls.push({ type: "actions", title, subtitle, items }),
  };
}

function makeController(options: {
  adapter?: MemoryAdapter;
  documents?: readonly RetrievalDocument[];
  enabled?: boolean;
  model?: string;
  embedder?: RetrievalEmbedder;
  activeNotePath?: string | null;
} = {}): {
  controller: SemanticIndexWorkflowController;
  adapter: MemoryAdapter;
  calls: RenderCall[];
  loadedFolders: Array<readonly string[] | undefined>;
} {
  const adapter = options.adapter ?? new MemoryAdapter();
  const calls: RenderCall[] = [];
  const loadedFolders: Array<readonly string[] | undefined> = [];
  return {
    adapter,
    calls,
    loadedFolders,
    controller: new SemanticIndexWorkflowController({
      adapter: adapter.asDataAdapter(),
      indexPath: () => INDEX_PATH,
      activeProject: () => ({ name: "Client Work", folders: ["Projects"] }),
      activeNotePath: () => options.activeNotePath ?? "Research/Retrieval.md",
      loadDocuments: async (scopeFolders) => {
        loadedFolders.push(scopeFolders);
        const docs = [...(options.documents ?? MULTILINGUAL_RETRIEVAL_FIXTURE)];
        if (!scopeFolders) return docs;
        return docs.filter((doc) =>
          scopeFolders.some((folder) => folder === "" || doc.path === folder || doc.path.startsWith(`${folder}/`)),
        );
      },
      embeddingConfig: () => ({
        provider: "openai-compatible",
        model: options.model ?? FAKE_EMBEDDING_PROFILE.id,
        dimensions: FAKE_EMBEDDING_PROFILE.dimensions,
        languageCoverage: FAKE_EMBEDDING_PROFILE.languageCoverage,
        baseUrl: "http://localhost:11434/v1",
      }),
      embeddingsEnabled: () => options.enabled ?? true,
      activeEmbeddingModel: () => options.model ?? FAKE_EMBEDDING_PROFILE.id,
      batchSize: () => 1,
      createEmbedder: () => options.embedder ?? new DeterministicFakeEmbedder(),
      renderer: renderer(calls),
    }),
  };
}

describe("SemanticIndexWorkflowController", () => {
  it("renders empty status when no index exists", async () => {
    const { controller, calls } = makeController();

    await controller.run("status");

    expect(calls).toContainEqual({
      type: "info",
      title: "Semantic index",
      entries: [["Status", "No semantic index has been created yet."]],
    });
  });

  it("estimates scoped tag indexes and formats rows", async () => {
    const { controller, calls, loadedFolders } = makeController();

    await controller.run("estimate tag rag");

    expect(loadedFolders).toEqual([undefined]);
    expect(calls).toContainEqual({
      type: "info",
      title: "Semantic index estimate",
      entries: expect.arrayContaining([
        ["Scope", 'tag "#rag"'],
        ["Documents", "1"],
      ]),
    });
  });

  it("rejects unsafe starts and disabled embedding settings", async () => {
    const vault = makeController();
    await vault.controller.run("start vault");
    expect(vault.calls).toContainEqual({
      type: "error",
      message: "Full-vault semantic indexing is never implicit. Re-run with /semantic-index start vault --confirm-vault.",
    });

    const disabled = makeController({ enabled: false });
    await disabled.controller.run("start folder Projects");
    expect(disabled.calls).toContainEqual({
      type: "error",
      message: "Enable embeddings in Settings -> Resources before starting semantic indexing.",
    });
  });

  it("starts semantic indexing with an injected embedder and renders persisted status rows", async () => {
    const ctx = makeController();

    await ctx.controller.run("start folder Projects");

    const stored = await readSemanticIndexFile(ctx.adapter.asDataAdapter() as DataAdapter, INDEX_PATH);
    expect(stored?.state.status.state).toBe("complete");
    expect(stored?.snapshot?.model.id).toBe(FAKE_EMBEDDING_PROFILE.id);
    expect(ctx.calls).toContainEqual({
      type: "info",
      title: "Semantic index",
      entries: [["Start", 'Indexing 1 notes for folder "Projects".']],
    });
    expect(ctx.calls).toContainEqual({
      type: "info",
      title: "Semantic index",
      entries: semanticIndexRows(stored!),
    });
  });

  it("cancels an active semantic indexing run", async () => {
    const embedder = new BlockingEmbedder();
    const ctx = makeController({ embedder, documents: MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, 2) });

    const running = ctx.controller.run("start vault --confirm-vault");
    await embedder.started;
    ctx.controller.cancel();
    await running;

    const stored = await readSemanticIndexFile(ctx.adapter.asDataAdapter() as DataAdapter, INDEX_PATH);
    expect(stored?.state.status.state).toBe("cancelled");
    expect(ctx.calls).toContainEqual({
      type: "info",
      title: "Semantic index",
      entries: [["Cancel", "Cancellation requested. The current batch will stop before the next request."]],
    });
  });

  it("formats estimate and index rows as stable UI tuples", async () => {
    const ctx = makeController();
    await ctx.controller.run("start folder Projects");
    const stored = await readSemanticIndexFile(ctx.adapter.asDataAdapter() as DataAdapter, INDEX_PATH);
    if (!stored?.state.estimate) throw new Error("Expected estimate in stored index.");

    expect(semanticEstimateRows(stored.state.scope, MULTILINGUAL_RETRIEVAL_FIXTURE.slice(0, 1), stored.state.estimate)).toEqual(
      expect.arrayContaining([
        ["Scope", 'folder "Projects"'],
        ["Documents", "1"],
        ["Batches", "1"],
      ]),
    );
    expect(semanticIndexRows(stored)).toEqual(
      expect.arrayContaining([
        ["Status", 'Indexing complete for folder "Projects": 1 documents indexed.'],
        ["Model", FAKE_EMBEDDING_PROFILE.id],
        ["Index records", "1"],
      ]),
    );
  });
});

class BlockingEmbedder implements RetrievalEmbedder {
  readonly profile = FAKE_EMBEDDING_PROFILE;
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  async embed(input: EmbeddingInput, options?: EmbeddingRequestOptions): Promise<EmbeddingResult> {
    return (await this.embedBatch([input], options))[0];
  }

  async embedBatch(_inputs: readonly EmbeddingInput[], options?: EmbeddingRequestOptions): Promise<EmbeddingResult[]> {
    this.markStarted();
    return await new Promise<EmbeddingResult[]>((resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      if (options?.signal?.aborted) reject(new Error("aborted"));
      else setTimeout(() => resolve([]), 1000);
    });
  }
}
