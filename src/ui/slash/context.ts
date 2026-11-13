import type { App } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type AgenticChatPlugin from "../../main";
import type { AgentService } from "../../agent/agent-service";
import type { OutputStyle } from "../../agent/output-styles";
import type { ContextAttachment } from "../context-attachments";
import type { ActionRow, WorkflowRenderer } from "../workflow-renderer";
import type { SessionWorkflowController } from "../session-workflow-controller";
import type { SessionActivationCoordinator } from "../session-activation-coordinator";
import type { MemoryWorkflowController } from "../memory-workflow-controller";
import type { SemanticIndexWorkflowController } from "../semantic-index-workflow-controller";

/**
 * Narrow view of ChatView used by the slash handlers. Only the members the
 * handler modules really touch are listed here, so a handler cannot reach into
 * unrelated view internals.
 */
export interface SlashContext {
  service: AgentService;
  plugin: AgenticChatPlugin;
  app: App;
  clearEmptyState(): void;
  renderInfoMessage(title: string, entries: Array<[string, string]>): void;
  renderActionList(title: string, subtitle: string, items: ActionRow[]): void;
  renderErrorMessage(message: string): void;
  showServiceError(): void;
  renderOutgoingUserMessage(text: string, attachments: ContextAttachment[], images?: ImageContent[]): void;
  renderTranscript(messages: AgentMessage[]): void;
  syncChrome(): void;
  setOutputStyle(style: OutputStyle): Promise<void>;
  setComposerValue(text: string): void;
  inputEl: HTMLTextAreaElement;
  createSessionWorkflow(): SessionWorkflowController;
  createSessionActivationCoordinator(): SessionActivationCoordinator;
  createMemoryWorkflow(): MemoryWorkflowController;
  semanticIndexWorkflowController(): SemanticIndexWorkflowController;
  workflowRenderer(): WorkflowRenderer;
  clearAllSessions(): Promise<number>;
  loadSession(path: string): Promise<void>;
  deleteSessionFromList(path: string): Promise<void>;
  activeNotePath: string | null;
  semanticIndexWorkflow: SemanticIndexWorkflowController | null;
}
