import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { App } from "obsidian";
import type { AgentService } from "../agent/agent-service";
import type { ChatTab } from "./chat-tabs";
import type { ChatTabWorkingState, StagedPromptContext } from "./chat-tab-state";
import { stagePromptContext } from "./chat-tab-state";
import { parseInlineInstruction, resolveComposerAction, stripContextPreamble, type ComposerSubmitSource } from "./composer-input";
import { parseSlashInput, retiredCommandHint } from "./commands";
import { assemblePrompt, buildPromptContext, loadImageAttachments as loadContextImageAttachments } from "./context-builder";
import type { ContextAttachment } from "./context-attachments";
import { errorMessage } from "../utils/errors";
import { failedLastTurnIndex, lastUserTurn, toolResultText } from "./message-content";
import { safeJson } from "./format";
import type { TranscriptView } from "./transcript-view";

export interface ChatTurnComposerPort {
  queueComposerPrompt(): void;
  pushHistory(text: string): void;
  clearQueuedPrompt(): void;
  endEditing(restoreDraft: boolean): void;
  readonly editIndex: number | null;
}

export interface ChatTurnChromePort {
  setRunning(running: boolean): void;
  notifyTurnComplete(): void;
}

export interface ChatTurnDeps {
  app: App;
  service: () => AgentService;
  activeTab: () => ChatTab;
  state: () => ChatTabWorkingState;
  isLiveTab: (tab: ChatTab) => boolean;
  inputEl: () => HTMLTextAreaElement;
  statusEl: () => HTMLElement;
  transcript: () => TranscriptView;
  chrome: () => ChatTurnChromePort;
  composer: () => ChatTurnComposerPort;
  clearEmptyState: () => void;
  effectiveActiveNote: () => string | null;
  handleSlashCommand: (raw: string) => Promise<boolean>;
  sendPrompt: (text: string) => Promise<void>;
  renderErrorMessage: (message: string) => void;
  renderOutgoingUserMessage: (text: string, attachments: ContextAttachment[], images?: ImageContent[]) => void;
  renderTranscript: (messages: AgentMessage[]) => void;
  showServiceError: () => void;
  scrollToBottom: (options?: { force?: boolean }) => void;
  renderChips: () => void;
  syncChrome: () => void;
}

/**
 * Owns the prompt pipeline: submit, queue/steer, send, retry, edit-and-resend,
 * and the agent event switch that ends in the transcript and chrome.
 */
export class ChatTurn {
  private flushingQueuedPrompt = false;

  constructor(private readonly deps: ChatTurnDeps) {}

  async submit(source: ComposerSubmitSource): Promise<void> {
    const composer = this.deps.composer();
    const input = this.deps.inputEl();
    const service = this.deps.service();
    // (autocomplete handles its own hide; the view calls cancel before submit)
    const text = input.value.trim();
    if (!text) return;

    // One decision for Enter, the toolbar button, the queue action, and steering.
    switch (resolveComposerAction(source, service.isStreaming())) {
      case "queue":
        composer.queueComposerPrompt();
        return;
      case "steer":
        if (text.startsWith("#")) {
          this.deps.renderErrorMessage("Wait for the agent to finish before saving a standing instruction.");
          return;
        }
        if (text.startsWith("/")) {
          this.deps.renderErrorMessage(retiredCommandHint(parseSlashInput(text).word) ?? "Wait for the agent to finish before running a slash command.");
          return;
        }
        composer.pushHistory(text);
        input.value = "";
        await this.steerActiveTurn(text);
        return;
      case "send":
        break;
    }

    const editIndex = composer.editIndex;
    composer.endEditing(false);

    // The guard closes the window between "not streaming" and "prompt started".
    if (service.isTurnInFlight()) {
      this.deps.statusEl().setText("A turn is already starting — wait for it to finish, then send again.");
      return;
    }

    composer.pushHistory(text);
    if (text.startsWith("#")) {
      input.value = "";
      await this.captureInlineInstruction(text);
      return;
    }
    if (text.startsWith("/")) {
      input.value = "";
      const handled = await this.deps.handleSlashCommand(text);
      if (handled) {
        return;
      }
    }
    input.value = "";
    if (editIndex !== null) {
      await this.editAndResend(editIndex, text);
      return;
    }
    await this.deps.sendPrompt(text);
  }

  /** Stop the turn and cancel the composer hold, keeping the draft for a new send. */
  stopActiveTurn(): void {
    // A held draft must not auto-send after a stop. The text stays in the
    // composer so the next Enter sends it as a replacement turn.
    this.deps.composer().clearQueuedPrompt();
    this.deps.service().abort();
  }

  async flushQueuedPromptIfReady(): Promise<void> {
    const service = this.deps.service();
    const state = this.deps.state();
    // A swap may notify listeners while it is still activating. Flushing then
    // would send the old draft into the session that is being installed.
    const swapState = service.getSessionSwapState();
    if (swapState !== "idle" && swapState !== "live") return;
    if (!state.queuedPromptArmed || this.flushingQueuedPrompt || service.isStreaming()) return;
    const input = this.deps.inputEl();
    const text = input.value.trim();
    state.queuedPromptArmed = false;
    this.deps.renderChips();
    if (!text) {
      this.deps.syncChrome();
      return;
    }
    this.flushingQueuedPrompt = true;
    try {
      this.deps.composer().pushHistory(text);
      input.value = "";
      await this.deps.sendPrompt(text);
    } finally {
      this.flushingQueuedPrompt = false;
      this.deps.renderChips();
      this.deps.syncChrome();
    }
  }

  /** Rewind to `index`, drop that turn and everything after, then send the edit. */
  async editAndResend(index: number, text: string): Promise<void> {
    try {
      await this.deps.service().truncateMessages(index);
    } catch (error) {
      // A failed session rewrite must not silently swallow the edit.
      this.deps.renderErrorMessage(errorMessage(error));
      return;
    }
    this.deps.renderTranscript(this.deps.service().getMessages());
    await this.deps.sendPrompt(text);
  }

  /**
   * Build the prompt and images for `tab`, bound to the session that was active
   * at the start. Returns null when the tab stopped being the live one or its
   * session changed during the awaits; the staged context is discarded then.
   */
  private async preparePromptSend(
    tab: ChatTab,
    staged: StagedPromptContext,
    text: string,
  ): Promise<{ prompt: string; images: ImageContent[]; sessionToken: number; messageCountBefore: number } | null> {
    const service = tab.service;
    const app = this.deps.app;
    // A fresh tab has no session yet. Create/continue it before sampling the
    // token, otherwise the token changes during this same send and the guard
    // falsely rejects a valid first prompt.
    await service.initialize();
    // Context building and image encoding can take seconds. Bind the send to
    // the session that is active now so a swap during those awaits cannot
    // route the prompt into a different session.
    const sessionToken = service.getSessionToken();
    const stillBound = (): boolean => {
      if (!this.deps.isLiveTab(tab)) {
        staged.discard();
        return false;
      }
      if (service.getSessionToken() !== sessionToken) {
        staged.discard();
        service.reportSessionChanged();
        this.deps.showServiceError();
        return false;
      }
      return true;
    };
    if (!stillBound()) return null;
    const messageCountBefore = service.getMessages().length;
    const context = await buildPromptContext({
      app,
      attachments: staged.attachments,
      activeNotePath: staged.autoPath,
      isPathIgnored: (path) => service.isPathIgnored(path),
      activeNoteCache: staged.activeNoteCache,
      contextCache: staged.contextCache,
    });
    if (!stillBound()) return null;
    const prompt = assemblePrompt(context, text);
    // Image attachments ride as multimodal content parts, not text context.
    const images = await loadContextImageAttachments({
      app,
      attachments: staged.attachments,
      supportsImages: service.supportsImages(),
    });
    if (!stillBound()) return null;
    return { prompt, images, sessionToken, messageCountBefore };
  }

  async sendPrompt(text: string): Promise<void> {
    await this.dispatchPrompt(text, "send");
  }

  async steerActiveTurn(text: string): Promise<void> {
    await this.dispatchPrompt(text, "steer");
  }

  /**
   * One pipeline for a new turn ("send") and for text queued into the running
   * turn ("steer"): stage context from the active tab, build the prompt, hand it
   * to the service, then commit or discard the staged context depending on
   * whether the transcript grew.
   */
  private async dispatchPrompt(text: string, kind: "send" | "steer"): Promise<void> {
    const tab = this.deps.activeTab();
    const service = tab.service;
    const staged = stagePromptContext(tab.state, this.deps.effectiveActiveNote());
    this.deps.clearEmptyState();
    try {
      const prepared = await this.preparePromptSend(tab, staged, text);
      if (!prepared) return;
      tab.state.lastSentPrompt = prepared.prompt;
      tab.state.lastSentDisplay = text;
      if (kind === "send") {
        // Show the auto-attached active note alongside explicit attachments in the user bubble.
        const shown = [...(staged.autoPath ? [staged.autoPath] : []), ...staged.attachments];
        this.deps.renderOutgoingUserMessage(text, shown, prepared.images);
        await service.sendPrompt(prepared.prompt, prepared.images, prepared.sessionToken);
      } else {
        this.deps.statusEl().setText("Queued for the active turn.");
        await service.steerPrompt(prepared.prompt, prepared.images, prepared.sessionToken);
      }
      if (!this.deps.isLiveTab(tab)) {
        staged.discard();
        return;
      }
      staged.settle(service.getMessages().length > prepared.messageCountBefore);
    } catch (error) {
      staged.discard();
      if (!this.deps.isLiveTab(tab)) return;
      throw error;
    }
    this.deps.showServiceError();
  }

  /** Re-run the conversation's last user turn (inline "Ask again" action). */
  async retryLast(): Promise<void> {
    const tab = this.deps.activeTab();
    const service = tab.service;
    const state = this.deps.state();
    if (service.isStreaming()) return;
    // Bind the retry to the session that is active now: the transcript rewrite
    // below can await, and a same-tab session load during that await must not
    // receive this prompt.
    let sessionToken = service.getSessionToken();
    const lastTurn = lastUserTurn(service.getMessages());
    const prompt = state.lastSentPrompt ?? lastTurn?.text;
    if (!prompt) return;
    // Pair images with the text they were sent with: a stale lastSentPrompt
    // from a blocked send must not pick up an older turn's images.
    const images = lastTurn?.text === prompt ? lastTurn.images : [];
    const display = state.lastSentDisplay ?? stripContextPreamble(prompt);
    // A failed turn is replaced, not repeated: drop it so the model sees the
    // prompt once. Only when it is the turn being resent.
    const failedIndex = failedLastTurnIndex(service.getMessages());
    if (failedIndex !== undefined && lastTurn?.text === prompt) {
      try {
        // The rewind starts a new conversation token; bind the resend to it.
        sessionToken = await service.truncateMessages(failedIndex);
      } catch (error) {
        this.deps.renderErrorMessage(errorMessage(error));
        return;
      }
      if (service.getSessionToken() !== sessionToken) {
        service.reportSessionChanged();
        this.deps.showServiceError();
        return;
      }
      if (this.deps.isLiveTab(tab)) {
        this.deps.renderTranscript(service.getMessages());
      }
    }
    this.deps.clearEmptyState();
    // A retried image turn shows the same thumbnails it sends (#250).
    this.deps.renderOutgoingUserMessage(display, [], images);
    await service.sendPrompt(prompt, images, sessionToken);
    if (!this.deps.isLiveTab(tab)) return;
    this.deps.showServiceError();
  }

  async captureInlineInstruction(raw: string): Promise<void> {
    const instruction = parseInlineInstruction(raw);
    if (!instruction) {
      this.deps.renderErrorMessage("Add instruction text after #.");
      return;
    }
    this.deps.clearEmptyState();
    this.deps.renderOutgoingUserMessage(`# ${instruction}`, []);
    await this.deps.service().invokeInstruction(instruction);
    this.deps.showServiceError();
  }

  handleAgentEvent(event: AgentEvent): void {
    const transcript = this.deps.transcript();
    switch (event.type) {
      case "agent_start":
        this.deps.clearEmptyState();
        transcript.beginRun();
        this.deps.chrome().setRunning(true);
        break;
      case "message_start":
        if (event.message.role === "assistant") transcript.beginAssistantMessage();
        break;
      case "message_update":
        transcript.applyStreamDelta(event.assistantMessageEvent);
        break;
      case "message_end":
        if (event.message.role === "user") transcript.endUserMessage(event.message);
        if (event.message.role === "assistant") transcript.finalizeBubble(event.message);
        break;
      case "tool_execution_start":
        transcript.ensureBubble().startStep(event.toolCallId, event.toolName, safeJson(event.args));
        break;
      case "tool_execution_update":
        transcript.ensureBubble().updateStep(event.toolCallId, event.partialResult);
        break;
      case "tool_execution_end":
        transcript.ensureBubble().endStep(
          event.toolCallId,
          toolResultText(event.result),
          event.isError,
          event.result,
        );
        break;
      case "agent_end":
        transcript.endRun();
        this.deps.chrome().setRunning(false);
        this.deps.statusEl().setText("");
        this.deps.syncChrome();
        this.deps.chrome().notifyTurnComplete();
        break;
      default:
        break;
    }
    this.deps.scrollToBottom();
  }
}
