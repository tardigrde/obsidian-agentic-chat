import type { App } from "obsidian";
import { createProxiedFetcher } from "../mcp/fetcher";
import { loadVaultRetrievalDocuments } from "../retrieval/relevant-notes";
import {
  OpenAICompatibleEmbeddingProvider,
  activeEmbeddingModel,
  embeddingConfigFromSettings,
} from "../retrieval/embeddings";
import { semanticIndexPath } from "../retrieval/semantic-index";
import type { AgenticChatSettings } from "../settings-schema";
import { SemanticIndexWorkflowController } from "./semantic-index-workflow-controller";
import type { WorkflowRenderer } from "./workflow-renderer";

/**
 * Builds the retrieval workflow the chat view runs. The view owns its
 * lifetime; this module owns how it reaches the vault and the providers.
 */

export interface SemanticIndexWorkflowHost {
  readonly app: App;
  readonly settings: AgenticChatSettings;
  readonly pluginDir: string | undefined;
  readonly pluginId: string;
  activeNotePath(): string | null;
  isPathIgnored(path: string): boolean;
  readonly renderer: WorkflowRenderer;
}

export function semanticIndexFilePath(host: SemanticIndexWorkflowHost): string {
  const pluginDir = host.pluginDir ?? `${host.app.vault.configDir}/plugins/${host.pluginId}`;
  return semanticIndexPath(pluginDir);
}

export function createSemanticIndexWorkflowController(
  host: SemanticIndexWorkflowHost,
): SemanticIndexWorkflowController {
  const embeddingConfig = (): ConstructorParameters<typeof OpenAICompatibleEmbeddingProvider>[0] =>
    embeddingConfigFromSettings(host.settings.embeddings, {
      openrouterApiKey: host.settings.openrouterApiKey,
      openaiCompatibleApiKey: host.settings.openaiCompatibleApiKey,
      ollamaBaseUrl: host.settings.ollamaBaseUrl,
      openaiCompatibleBaseUrl: host.settings.openaiCompatibleBaseUrl,
      privacy: host.settings.privacy,
    });
  return new SemanticIndexWorkflowController({
    adapter: host.app.vault.adapter,
    indexPath: () => semanticIndexFilePath(host),
    activeNotePath: () => host.activeNotePath(),
    loadDocuments: (scopeFolders) =>
      loadVaultRetrievalDocuments(host.app, (path) => host.isPathIgnored(path), scopeFolders),
    embeddingConfig,
    embeddingsEnabled: () => host.settings.embeddings.enabled,
    activeEmbeddingModel: () => activeEmbeddingModel(host.settings.embeddings),
    batchSize: () => host.settings.embeddings.batchSize,
    createEmbedder: () =>
      new OpenAICompatibleEmbeddingProvider(embeddingConfig(), createProxiedFetcher(host.settings.network)),
    renderer: host.renderer,
  });
}
