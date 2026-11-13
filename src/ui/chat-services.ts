import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { App } from "obsidian";
import { createProxiedFetcher } from "../mcp/fetcher";
import { loadVaultRetrievalDocuments } from "../retrieval/relevant-notes";
import {
  OpenAICompatibleEmbeddingProvider,
  activeEmbeddingModel,
  embeddingConfigFromSettings,
} from "../retrieval/embeddings";
import { semanticIndexPath } from "../retrieval/semantic-index";
import { EXPORT_FOLDER } from "../session/export";
import type { SessionInfo } from "../session/session-manager";
import type { AgenticChatSettings } from "../settings-schema";
import { memoryPathForApp } from "../tools/memory-tools";
import { writeVaultFile } from "../vault/storage";
import { MemoryWorkflowController } from "./memory-workflow-controller";
import { SemanticIndexWorkflowController } from "./semantic-index-workflow-controller";
import type { WorkflowRenderer } from "./workflow-renderer";

/**
 * Builds the retrieval and memory workflows the chat view runs. The view owns
 * their lifetimes; this module owns how they reach the vault, providers, and
 * export folder.
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

export interface MemoryWorkflowHost {
  readonly app: App;
  messages(): readonly AgentMessage[];
  sessionInfo(): SessionInfo | undefined;
  readonly renderer: WorkflowRenderer;
}

export function createMemoryWorkflowController(host: MemoryWorkflowHost): MemoryWorkflowController {
  return new MemoryWorkflowController({
    adapter: host.app.vault.adapter,
    memoryPath: () => memoryPathForApp(host.app),
    messages: () => host.messages(),
    defaultScope: () => "vault",
    sessionSource: () => {
      const session = host.sessionInfo();
      return session ? `[[Agentic Chat Sessions/${session.id}|Chat session]]` : undefined;
    },
    renderer: host.renderer,
    writeExport: async (filename, contents) => {
      const file = await writeVaultFile(host.app, `${EXPORT_FOLDER}/${filename}`, contents);
      return file.path;
    },
  });
}
