import type { DoctorReport } from "../../agent/doctor-report";
import type { App } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgenticChatHost } from "../../plugin-host";
import type { AgentService } from "../../agent/agent-service";
import type { ContextAttachment } from "../context-attachments";
import type { ActionRow, WorkflowRenderer } from "../workflow-renderer";
import type { SessionWorkflowController } from "../session-workflow-controller";
import type { SessionActivationCoordinator } from "../session-activation-coordinator";

/**
 * Narrow view of ChatView used by the slash handlers. Only the members the
 * handler modules really touch are listed here, so a handler cannot reach into
 * unrelated view internals.
 */
export interface SlashContext {
  service: AgentService;
  plugin: AgenticChatHost;
  app: App;
  clearEmptyState(): void;
  renderInfoMessage(title: string, entries: Array<[string, string]>): void;
  renderDoctorReport(report: DoctorReport): void;
  renderActionList(title: string, subtitle: string, items: ActionRow[]): void;
  renderErrorMessage(message: string): void;
  showServiceError(): void;
  renderOutgoingUserMessage(text: string, attachments: ContextAttachment[], images?: ImageContent[]): void;
  renderTranscript(messages: AgentMessage[]): void;
  syncChrome(): void;
  setComposerValue(text: string): void;
  inputEl: HTMLTextAreaElement;
  createSessionWorkflow(): SessionWorkflowController;
  createSessionActivationCoordinator(): SessionActivationCoordinator;
  workflowRenderer(): WorkflowRenderer;
  clearAllSessions(): Promise<number>;
  loadSession(path: string): Promise<void>;
  deleteSessionFromList(path: string): Promise<void>;
  activeNotePath: string | null;
}
