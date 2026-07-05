import type { DataAdapter } from "obsidian";
import {
  bootstrapSemanticIndex,
  readSemanticIndexFile,
  type SemanticIndexFile,
} from "../retrieval/semantic-index";
import {
  estimateEmbeddingIndexCost,
  formatRetrievalIndexStatus,
  type EmbeddingIndexCostEstimate,
  type RetrievalDocument,
  type RetrievalEmbedder,
  type RetrievalIndexScope,
} from "../retrieval/policy";
import { embeddingProfileFromConfig } from "../retrieval/embeddings";
import type { AgentProject } from "../projects/projects";
import { parseSemanticIndexScopeCommand } from "./semantic-index-command";
import type { WorkflowRenderer } from "./workflow-renderer";

export interface SemanticIndexWorkflowControllerOptions {
  adapter: DataAdapter;
  indexPath: () => string;
  activeProject: () => Pick<AgentProject, "name" | "folders"> | null | undefined;
  activeNotePath: () => string | null;
  loadDocuments: (scopeFolders?: readonly string[]) => Promise<RetrievalDocument[]>;
  embeddingConfig: () => Parameters<typeof embeddingProfileFromConfig>[0];
  embeddingsEnabled: () => boolean;
  activeEmbeddingModel: () => string | undefined;
  batchSize: () => number;
  createEmbedder: () => RetrievalEmbedder;
  renderer: WorkflowRenderer;
}

export class SemanticIndexWorkflowController {
  private abort: AbortController | null = null;

  constructor(private readonly options: SemanticIndexWorkflowControllerOptions) {}

  async run(arg: string): Promise<void> {
    this.options.renderer.clear();
    const [subcommand = "status", ...rest] = arg.trim().split(/\s+/).filter(Boolean);
    const action = subcommand.toLowerCase();
    if (action === "status") {
      await this.showStatus();
      return;
    }
    if (action === "cancel") {
      this.cancel();
      return;
    }
    if (action !== "estimate" && action !== "start") {
      this.options.renderer.error("Usage: /semantic-index [status|estimate|start|cancel] [folder <path>|tag <tag>|project|vault --confirm-vault]");
      return;
    }

    const parsed = parseSemanticIndexScopeCommand(rest, {
      activeProject: this.options.activeProject() ?? undefined,
      activeNotePath: this.options.activeNotePath(),
    });
    if ("error" in parsed) {
      this.options.renderer.error(parsed.error);
      return;
    }
    if (action === "start" && parsed.scope.kind === "vault" && !parsed.confirmVault) {
      this.options.renderer.error("Full-vault semantic indexing is never implicit. Re-run with /semantic-index start vault --confirm-vault.");
      return;
    }

    const { documents, estimate } = await this.prepare(parsed.scope);
    if (action === "estimate") {
      this.options.renderer.info("Semantic index estimate", semanticEstimateRows(parsed.scope, documents, estimate));
      return;
    }
    await this.start(parsed.scope, documents, estimate);
  }

  async showStatus(): Promise<void> {
    const file = await readSemanticIndexFile(this.options.adapter, this.options.indexPath());
    if (!file) {
      this.options.renderer.info("Semantic index", [["Status", "No semantic index has been created yet."]]);
      return;
    }
    this.options.renderer.info("Semantic index", semanticIndexRows(file));
  }

  cancel(): void {
    if (!this.abort) {
      this.options.renderer.info("Semantic index", [["Cancel", "No semantic indexing run is active."]]);
      return;
    }
    this.abort.abort();
    this.options.renderer.info("Semantic index", [["Cancel", "Cancellation requested. The current batch will stop before the next request."]]);
  }

  private async prepare(scope: RetrievalIndexScope): Promise<{
    documents: RetrievalDocument[];
    estimate: EmbeddingIndexCostEstimate;
  }> {
    const documents = await this.loadScopedDocuments(scope);
    const profile = embeddingProfileFromConfig(this.options.embeddingConfig());
    return {
      documents,
      estimate: estimateEmbeddingIndexCost({
        scope,
        model: profile,
        documentCount: documents.length,
        characterCount: documents.reduce((sum, document) => sum + document.content.length, 0),
        indexingBatchSize: this.options.batchSize(),
      }),
    };
  }

  private async loadScopedDocuments(scope: RetrievalIndexScope): Promise<RetrievalDocument[]> {
    const scopeFolders = scope.kind === "folder" || scope.kind === "project" ? scope.paths : undefined;
    const documents = await this.options.loadDocuments(scopeFolders);
    if (scope.kind !== "tag") return documents;
    const tags = new Set((scope.tags ?? []).map((tag) => tag.replace(/^#/, "").toLowerCase()));
    return documents.filter((document) => (document.tags ?? []).some((tag) => tags.has(tag.toLowerCase().replace(/^#/, ""))));
  }

  private async start(
    scope: RetrievalIndexScope,
    documents: RetrievalDocument[],
    estimate: EmbeddingIndexCostEstimate,
  ): Promise<void> {
    if (this.abort) {
      this.options.renderer.error("Semantic indexing is already running. Use /semantic-index cancel first.");
      return;
    }
    if (!this.options.embeddingsEnabled()) {
      this.options.renderer.error("Enable embeddings in Settings -> Resources before starting semantic indexing.");
      return;
    }
    if (!this.options.activeEmbeddingModel()) {
      this.options.renderer.error("Set an embedding model in Settings -> Resources before starting semantic indexing.");
      return;
    }
    this.options.renderer.info("Semantic index", [["Start", `Indexing ${documents.length} notes for ${scope.kind} "${scope.label}".`]]);
    const controller = new AbortController();
    this.abort = controller;
    try {
      const result = await bootstrapSemanticIndex({
        adapter: this.options.adapter,
        path: this.options.indexPath(),
        scope,
        documents,
        estimate,
        embedder: this.options.createEmbedder(),
        batchSize: this.options.batchSize(),
        signal: controller.signal,
      });
      this.options.renderer.info("Semantic index", semanticIndexRows(result.file));
    } finally {
      this.abort = null;
    }
  }
}

export function semanticEstimateRows(
  scope: RetrievalIndexScope,
  documents: readonly RetrievalDocument[],
  estimate: EmbeddingIndexCostEstimate,
): Array<[string, string]> {
  return [
    ["Scope", `${scope.kind} "${scope.label}"`],
    ["Documents", String(documents.length)],
    ["Estimated tokens", String(estimate.estimatedTokens)],
    ["Batches", String(estimate.estimatedBatches)],
    ["Estimated cost", estimate.estimatedCostUsd === undefined ? "local/unknown" : `$${estimate.estimatedCostUsd}`],
    ["Network", estimate.requiresNetwork ? "yes" : "no"],
    ["Warnings", estimate.warnings.length ? estimate.warnings.join(" ") : "none"],
  ];
}

export function semanticIndexRows(file: SemanticIndexFile): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Status", formatRetrievalIndexStatus(file.state.status)],
    ["Updated", new Date(file.updatedAt).toISOString()],
    ["Indexed documents", String(file.state.indexedDocumentIds.length)],
  ];
  if (file.snapshot) {
    rows.push(["Model", file.snapshot.model.id]);
    rows.push(["Dimensions", String(file.snapshot.model.dimensions)]);
    rows.push(["Index records", String(file.snapshot.records.length)]);
  }
  if (file.state.estimate) {
    rows.push(["Estimated tokens", String(file.state.estimate.estimatedTokens)]);
    if (file.state.estimate.estimatedCostUsd !== undefined) {
      rows.push(["Estimated cost", `$${file.state.estimate.estimatedCostUsd}`]);
    }
  }
  return rows;
}
