import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Usage } from "@earendil-works/pi-ai";
import { type App, type Component, Notice } from "obsidian";
import { errorMessage } from "../utils/errors";
import { AssistantBubble } from "./assistant-bubble";
import { FOLDER_PREFIX } from "./autocomplete";
import { stripContextPreamble } from "./composer-input";
import { contextAttachmentLabel, type ContextAttachment } from "./context-attachments";
import { collectUserImageThumbs } from "./image-attachments";
import { renderSummaryPanel } from "./info-panel-renderer";
import {
  assistantUsage,
  collectToolResults,
  messageImages,
  messageText,
  thinkingText,
  toolCalls,
  type MessageImageLite,
  type ToolResultLite,
} from "./message-content";
import { openSystemUrl } from "../platform/system-browser";
import { isPinnedToBottom } from "./scroll-pinning";
import { isSummaryMessage } from "../agent/compaction";

/** Cap inline image thumbnails per user bubble so a turn can't flood the pane. */
const MAX_USER_IMAGE_THUMBS = 8;

/** What the transcript needs from the chat view that owns it. */
export interface TranscriptViewHost {
  readonly app: App;
  /** Owns the markdown rendered into assistant bubbles. */
  readonly component: Component;
  renderEmptyState(): void;
  beginEdit(index: number, text: string, el: HTMLElement): void;
  retryLast(): void;
  abortSubagentChild(id: string): void;
}

/**
 * The messages pane of one chat view: history replay, the live assistant
 * bubble, user bubbles, and scroll pinning. The view's tabs share it; a tab
 * switch re-renders the transcript.
 */
export class TranscriptView {
  private bubble: AssistantBubble | null = null;
  private locallyRenderedUserMessages = 0;
  // Last error message rendered inside an assistant bubble. Used to suppress the
  // duplicate standalone error panel that showServiceError() would otherwise
  // emit for the same turn-level error (e.g. "Request was aborted").
  lastBubbleError: string | undefined;
  // Last completed turn's usage, shown collapsed in the single bottom bar.
  lastTurnUsage: Usage | null = null;
  private autoScrollPinned = true;
  private userScrollIntent = false;
  private userScrollIntentTimer: number | null = null;

  constructor(
    private readonly messagesEl: HTMLElement,
    private readonly host: TranscriptViewHost,
  ) {}

  /** agent_start: drop the previous run's bubble. */
  beginRun(): void {
    this.bubble?.dispose();
    this.bubble = null;
  }

  /** message_start for an assistant message. */
  beginAssistantMessage(): void {
    this.bubble?.dispose();
    this.bubble = this.newBubble();
    this.lastBubbleError = undefined;
    // The Thinking pill IS the turn's status: mount it immediately so any
    // latency between here and the first token reads as "Thinking…".
    this.bubble.beginThinking();
  }

  /** message_end for a user message: skip the one this view already rendered. */
  endUserMessage(message: AgentMessage): void {
    if (this.locallyRenderedUserMessages > 0) this.locallyRenderedUserMessages -= 1;
    else
      this.renderUserMessage(stripContextPreamble(messageText(message)), [], undefined, {
        historyImages: messageImages(message),
      });
  }

  /** agent_end: settle a bubble that never got final text. */
  endRun(): void {
    this.bubble?.finalizeWithoutText();
  }

  /** Forget the live bubble without disposing it (the next render replaces the DOM). */
  forgetBubble(): void {
    this.bubble = null;
  }

  dispose(): void {
    this.bubble?.dispose();
    this.bubble = null;
    if (this.userScrollIntentTimer !== null) window.clearTimeout(this.userScrollIntentTimer);
    this.userScrollIntentTimer = null;
  }

  /** Render an auto-compaction summary as a collapsed, non-editable transcript block. */
  private renderSummaryMessage(text: string): void {
    renderSummaryPanel(this.messagesEl, text);
    this.scrollToBottom();
  }

  renderTranscript(messages: AgentMessage[]): void {
    this.messagesEl.empty();
    this.bubble = null;
    this.lastBubbleError = undefined;
    const toolResults = collectToolResults(messages);
    const lastAssistant = lastIndex(messages, (message) => message.role === "assistant");
    let rendered = 0;
    messages.forEach((message, index) => {
      if (message.role === "user" && isSummaryMessage(message)) {
        // A compaction summary isn't a user turn: show it as a distinct,
        // non-editable block instead of an editable user bubble.
        this.renderSummaryMessage(messageText(message));
        rendered += 1;
      } else if (message.role === "user") {
        // Hide the attachment <context> preamble so history reads like the
        // live transcript (which renders the user's text, not the prompt).
        // Vision attachments persist as image blocks — render them as thumbnails.
        this.renderUserMessage(stripContextPreamble(messageText(message)), [], index, {
          historyImages: messageImages(message),
        });
        rendered += 1;
      } else if (message.role === "assistant") {
        this.renderAssistantMessage(message, toolResults, index === lastAssistant);
        rendered += 1;
      }
    });
    if (rendered === 0) this.host.renderEmptyState();
    this.scrollToBottom();
  }

  private renderAssistantMessage(
    message: AgentMessage,
    toolResults: Map<string, ToolResultLite>,
    isLast: boolean,
  ): void {
    const bubble = this.newBubble();
    // Mirror the live path: every assistant turn gets its Thinking → Thought
    // status pill (mount eagerly, settle on finalize) so history replay renders
    // identically to the live stream for text-only turns too.
    bubble.beginThinking();
    const reasoning = thinkingText(message);
    if (reasoning) bubble.appendReasoning(reasoning);
    for (const call of toolCalls(message)) {
      bubble.startStep(call.id, call.name, JSON.stringify(call.arguments ?? {}));
      const result = toolResults.get(call.id);
      // Pass the persisted details wrapped in the result shape endStep reads
      // (`resultObject.details`), so replay re-derives the live verdict — a
      // stopped subagent dispatch must render red here too, not green.
      if (result) bubble.endStep(call.id, result.text, result.isError, { details: result.details });
    }
    this.applyAssistantMessage(bubble, message, { canRetry: isLast });
  }

  /**
   * One renderer for the settled part of an assistant turn. The live stream and
   * history replay call this with the same message, so finalize, error, and
   * usage handling cannot drift. `canRetry` is the caller's policy: history only
   * offers it on the last turn; the live path always does.
   */
  private applyAssistantMessage(
    bubble: AssistantBubble,
    message: AgentMessage,
    options: { canRetry: boolean },
  ): void {
    const text = messageText(message);
    if (text) {
      void bubble.finalizeText(text, this.host.app, this.host.component);
      bubble.showActions({ canRetry: options.canRetry });
    } else {
      bubble.finalizeWithoutText();
    }
    const errorMessage = (message as { errorMessage?: string }).errorMessage;
    if (errorMessage) {
      bubble.showError(errorMessage);
      if (options.canRetry) this.lastBubbleError = errorMessage;
    }
    const usage = assistantUsage(message);
    if (usage) {
      this.lastTurnUsage = usage;
    }
  }

  private renderUserMessage(
    text: string,
    attachments: ContextAttachment[],
    editIndex?: number,
    options: { forceScroll?: boolean; historyImages?: MessageImageLite[] } = {},
  ): void {
    const el = this.messagesEl.createDiv({ cls: ["agentic-chat-message", "agentic-chat-user"] });
    if (attachments.length > 0) {
      const labels = attachments.map((entry) =>
        typeof entry === "string" && entry.startsWith(FOLDER_PREFIX)
          ? `${entry.slice(FOLDER_PREFIX.length)}/`
          : contextAttachmentLabel(entry),
      );
      el.createDiv({ cls: "agentic-chat-user-attachments", text: `Attached: ${labels.join(", ")}` });
    }
    const thumbs = this.userImageThumbs(attachments, options.historyImages);
    if (thumbs.length > 0) {
      const wrap = el.createDiv({ cls: "agentic-chat-user-images" });
      for (const thumb of thumbs) {
        const img = wrap.createEl("img", {
          cls: ["agentic-chat-user-image", ...(thumb.path ? ["is-openable"] : [])],
          // Lazy: a long transcript can hold many persisted images.
          attr: { src: thumb.src, alt: thumb.alt, loading: "lazy" },
        });
        img.setAttr("title", thumb.alt);
        if (thumb.path) {
          const path = thumb.path;
          const open = (event: Event): void => {
            // History bubbles are editable: don't let a thumbnail click fall
            // through to the bubble's click-to-edit handler.
            event.stopPropagation();
            void this.host.app.workspace.openLinkText(path, "", false);
          };
          img.setAttrs({ role: "button", tabindex: "0", "aria-label": `Open ${thumb.alt}` });
          img.addEventListener("click", open);
          img.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            open(event);
          });
        }
      }
    }
    el.createDiv({ cls: "agentic-chat-user-text", text });
    // Persisted turns are editable: click to reload the prompt and rewrite it.
    if (editIndex !== undefined) {
      el.addClass("is-editable");
      el.setAttribute("aria-label", "Click to edit and resend");
      el.addEventListener("click", () => {
        // Don't hijack a text selection inside this bubble (it's selectable for
        // copying); a selection elsewhere on the page shouldn't block editing.
        const selection = window.getSelection();
        if (selection?.toString() && selection.anchorNode && el.contains(selection.anchorNode)) return;
        this.host.beginEdit(editIndex, stripContextPreamble(text), el);
      });
    }
    this.scrollToBottom({ force: options.forceScroll });
  }

  renderOutgoingUserMessage(text: string, attachments: ContextAttachment[], images?: ImageContent[]): void {
    this.locallyRenderedUserMessages += 1;
    this.renderUserMessage(text, attachments, undefined, { forceScroll: true, historyImages: images });
  }

  /**
   * Thumbnail sources for a user bubble: live vault-path attachments resolve to
   * resource URLs (click opens the vault image); replayed vision blocks render
   * from their persisted base64 data. Capped so a turn can't flood the pane.
   */
  private userImageThumbs(
    attachments: ContextAttachment[],
    historyImages?: MessageImageLite[],
  ): Array<{ src: string; alt: string; path?: string }> {
    return collectUserImageThumbs(
      attachments,
      historyImages,
      (base) => {
        const file = this.host.app.vault.getFileByPath(base);
        if (!file) return null;
        return this.host.app.vault.getResourcePath(file);
      },
      MAX_USER_IMAGE_THUMBS,
    );
  }

  applyStreamDelta(event: { type: string; delta?: string }): void {
    const bubble = this.bubble;
    if (!bubble) return;
    if (event.type === "text_delta" && event.delta) bubble.appendText(event.delta);
    else if (event.type === "thinking_delta" && event.delta) bubble.appendReasoning(event.delta);
  }

  finalizeBubble(message: AgentMessage): void {
    const bubble = this.bubble;
    if (!bubble) return;
    this.applyAssistantMessage(bubble, message, { canRetry: true });
  }

  private newBubble(): AssistantBubble {
    return new AssistantBubble(this.messagesEl, {
      onRetry: () => this.host.retryLast(),
      onOpenExternalLink: (target) => void this.openRenderedExternalLink(target),
      onOpenNote: (path) => void this.host.app.workspace.openLinkText(path, "", false),
      onContentChange: () => this.scrollToBottom(),
      onStopSubagentChild: (id) => this.host.abortSubagentChild(id),
    });
  }

  private async openRenderedExternalLink(target: string): Promise<void> {
    try {
      await openSystemUrl(target);
    } catch (error) {
      new Notice(`Could not open link: ${errorMessage(error)}`);
    }
  }

  ensureBubble(): AssistantBubble {
    this.bubble ??= this.newBubble();
    return this.bubble;
  }

  private scrollPending = false;
  private scrollForcePending = false;

  markUserScrollIntent(): void {
    this.userScrollIntent = true;
    if (this.userScrollIntentTimer !== null) window.clearTimeout(this.userScrollIntentTimer);
    this.userScrollIntentTimer = window.setTimeout(() => {
      this.userScrollIntent = false;
      this.userScrollIntentTimer = null;
    }, 250);
  }

  updateScrollPinning(): void {
    if (isPinnedToBottom(this.messagesEl)) {
      this.autoScrollPinned = true;
      return;
    }
    if (this.userScrollIntent) this.autoScrollPinned = false;
  }

  scrollToBottom(options: { force?: boolean } = {}): void {
    if (!options.force && !this.autoScrollPinned) return;
    this.scrollForcePending ||= !!options.force;
    if (this.scrollPending) return;
    this.scrollPending = true;
    window.requestAnimationFrame(() => {
      const force = this.scrollForcePending;
      this.scrollPending = false;
      this.scrollForcePending = false;
      if (!force && !this.autoScrollPinned) return;
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.autoScrollPinned = isPinnedToBottom(this.messagesEl);
    });
  }
}

/** Index of the last element matching `predicate`, or -1. */
function lastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}
