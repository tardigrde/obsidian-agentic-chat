import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Usage } from "@earendil-works/pi-ai";
import { type App, type Component, Notice } from "obsidian";
import { errorMessage } from "../utils/errors";
import { AssistantBubble } from "./assistant-bubble";
import { ActivityLine, type ApprovalRecord } from "./activity-line";
import type { ApprovalCard } from "./approval-card";
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
import { acHook } from "./test-hooks";
import { addUsage, emptyUsage } from "../agent/usage";
import { subagentDetailsUsage } from "../agent/session-usage";
import { formatTurnMeta, truncateText } from "./format";
import { parseSubagentReport, reportChildDetails } from "../agent/subagent-reports";
import { unwrapToolOutput } from "../tools/tool-output-wrapper";
import type { SubagentTranscriptEntry } from "../tools/subagent-tool";
import { openSystemUrl } from "../platform/system-browser";
import { isPinnedToBottom } from "./scroll-pinning";
import { isSummaryMessage } from "../agent/compaction";
import { isVaultFolder, openVaultPath } from "./vault-open";

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
  openSubagentReport?(artifactId: string, title: string): void;
  loadSubagentTimeline?(artifactId: string): Promise<SubagentTranscriptEntry[]>;
  /** Whether the tab that owns this transcript has a turn in flight. */
  isStreaming?(): boolean;
}

/**
 * The messages pane of one chat view: history replay, the live assistant
 * bubble, user bubbles, and scroll pinning. The view's tabs share it; a tab
 * switch re-renders the transcript.
 */
export class TranscriptView {
  private bubble: AssistantBubble | null = null;
  // The open segment of the current turn: one activity line per run of steps
  // between two texts (U4 #1). A turn reads `[steps] text [steps] text`.
  private activity: ActivityLine | null = null;
  private turnSegments: ActivityLine[] = [];
  /** Files a child read, from its report: cited under the answer of the turn it lands in (U5 #14). */
  private readonly reportSources = new Set<string>();
  /** Every segment on screen: a background child's row may sit in an earlier turn (U5 #1). */
  private readonly allSegments = new Set<ActivityLine>();
  // Bubbles created in the open segment: once one has text, the next step opens a new segment.
  private segmentBubbles: AssistantBubble[] = [];
  private turnLive = false;
  private turnBubbles: AssistantBubble[] = [];
  // Settled approvals by tool call id, so a re-render (tab switch) keeps the record line.
  private readonly approvalOutcomes = new Map<string, ApprovalRecord>();
  private turnError = false;
  private locallyRenderedUserMessages = 0;
  // Last error message rendered inside an assistant bubble. Used to suppress the
  // duplicate standalone error panel that showServiceError() would otherwise
  // emit for the same turn-level error (e.g. "Request was aborted").
  lastBubbleError: string | undefined;
  // Usage of the current turn (every assistant message since the last user
  // message), shown as the per-answer meta. A live run also times itself.
  private turnUsage: Usage | null = null;
  private runStartedAt: number | null = null;
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
    // A re-render during this run (tab switch) left its activity open; keep it.
    if (!this.activity) {
      this.turnUsage = null;
      this.startTurn(true);
    }
    this.runStartedAt = performance.now();
  }

  /** A new turn: its first segment, then the turn's messages below it. */
  private startTurn(live: boolean): ActivityLine {
    this.finishTurn();
    this.turnBubbles = [];
    this.turnError = false;
    this.turnLive = live;
    return this.openSegment();
  }

  /** The next segment of the turn: a fresh activity line at the end of the transcript. */
  private openSegment(): ActivityLine {
    const previous = this.activity;
    // The earlier segment's steps are over: settle its line (spinner, clock).
    if (previous && !previous.hasRunningStep) previous.finish();
    const segment = new ActivityLine(this.messagesEl, {
      live: this.turnLive,
      onOpenNote: (path) => openVaultPath(this.host.app, path),
      isFolder: (path) => isVaultFolder(this.host.app, path),
      onStopSubagentChild: (id) => this.host.abortSubagentChild(id),
      onOpenSubagentReport: (artifactId, title) => this.host.openSubagentReport?.(artifactId, title),
      loadSubagentTimeline: (artifactId) => this.host.loadSubagentTimeline?.(artifactId) ?? Promise.resolve([]),
      onChange: () => this.scrollToBottom(),
    });
    this.allSegments.add(segment);
    this.activity = segment;
    this.turnSegments.push(segment);
    this.segmentBubbles = [];
    return segment;
  }

  /** The turn is over: settle its segments and put its sources under the answer. */
  private finishTurn(): void {
    const segments = this.turnSegments;
    if (segments.length === 0 && !this.activity) return;
    this.activity = null;
    this.turnSegments = [];
    this.segmentBubbles = [];
    segments.forEach((segment, index) => segment.finish({ error: this.turnError && index === segments.length - 1 }));
    const sources = new Set<string>(this.reportSources);
    this.reportSources.clear();
    for (const segment of segments) for (const path of segment.sourcePaths) sources.add(path);
    const answer = [...this.turnBubbles].reverse().find((bubble) => bubble.hasText) ?? this.turnBubbles.at(-1);
    answer?.renderSourceChips(sources);
    this.turnBubbles = [];
  }

  /** The open segment of the turn in flight, if any. */
  get currentActivity(): ActivityLine | null {
    return this.activity;
  }

  /**
   * A waiting approval shows below the open segment, outside its block. A
   * settled one leaves the transcript: its step row keeps one line,
   * `Allowed by you` or `Denied by you` (U4 #4).
   */
  mountApproval(card: ApprovalCard): void {
    if (card.settled) {
      this.recordApproval(card);
      return;
    }
    const slot = this.activity?.approvalSlot ?? this.messagesEl;
    if (card.el.parentElement !== slot) slot.appendChild(card.el);
    this.activity?.setNeedsYou(true);
    this.scrollToBottom({ force: true });
  }

  /**
   * One card settled: record the decision on its step row and drop the card.
   * A card with no step row to hold it (no call id) stays as its one-line record.
   */
  recordApproval(card: ApprovalCard): void {
    const outcome = card.outcome;
    const id = card.toolCallId;
    const segment = id ? this.turnSegments.find((candidate) => candidate.hasStep(id)) : undefined;
    if (outcome && id) this.approvalOutcomes.set(id, outcome);
    if (outcome && id && segment) {
      card.el.remove();
      segment.recordApproval(id, outcome);
      return;
    }
    if (!card.el.isConnected) (this.activity?.approvalSlot ?? this.messagesEl).appendChild(card.el);
  }

  private applyApprovalRecord(id: string): void {
    const outcome = this.approvalOutcomes.get(id);
    if (!outcome) return;
    const segment = this.turnSegments.find((candidate) => candidate.hasStep(id));
    segment?.recordApproval(id, outcome);
  }

  /** Every approval settled: the activity line drops its needs-you state. */
  approvalSettled(): void {
    this.activity?.setNeedsYou(false);
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

  /** A background child changed: update its row, wherever its turn is (U5 #1). */
  updateSubagent(toolCallId: string, details: unknown): void {
    for (const segment of this.allSegments) if (segment.updateSubagent(toolCallId, details)) return;
  }

  /**
   * A child's report reached the parent: a small event line, not the user's
   * bubble. `settleRow` also gives the row its final state (history replay;
   * live, the row already settled through `updateSubagent`).
   */
  private renderSubagentReport(text: string, settleRow: boolean): boolean {
    const report = parseSubagentReport(text);
    if (!report) return false;
    const body = unwrapToolOutput(report.body);
    for (const path of report.sources ?? []) this.reportSources.add(path);
    if (settleRow) this.updateSubagent(report.toolCallId, reportChildDetails(report, body));
    const el = acHook(this.messagesEl.createEl("details", { cls: ["agentic-chat-subagent-event", `is-${report.status}`] }), "subagent-event");
    const label = report.status === "done" ? "reported back" : report.status === "aborted" ? "was stopped" : "failed";
    el.createEl("summary", { text: `Subagent ${report.agent} (${report.childId}) ${label}` });
    el.createEl("pre", { text: truncateText(body, 4_000) });
    this.scrollToBottom();
    return true;
  }

  /** message_end for a user message: skip the one this view already rendered. */
  endUserMessage(message: AgentMessage): void {
    if (this.renderSubagentReport(messageText(message), false)) return;
    if (this.locallyRenderedUserMessages > 0) this.locallyRenderedUserMessages -= 1;
    else
      this.renderUserMessage(stripContextPreamble(messageText(message)), [], undefined, {
        historyImages: messageImages(message),
      });
  }

  /** agent_end: settle a bubble that never got final text. */
  endRun(): void {
    this.bubble?.finalizeWithoutText();
    this.finishTurn();
    this.runStartedAt = null;
  }

  /** Forget the live bubble without disposing it (the next render replaces the DOM). */
  forgetBubble(): void {
    this.bubble = null;
  }

  dispose(): void {
    for (const segment of this.allSegments) segment.dispose();
    this.allSegments.clear();
    this.activity?.dispose();
    this.activity = null;
    this.turnSegments = [];
    this.destroyMountedBubbles();
    this.bubble = null;
    if (this.userScrollIntentTimer !== null) window.clearTimeout(this.userScrollIntentTimer);
    this.userScrollIntentTimer = null;
  }

  /** Render an auto-compaction summary as a collapsed, non-editable transcript block. */
  private renderSummaryMessage(text: string): void {
    renderSummaryPanel(this.messagesEl, text);
    this.scrollToBottom();
  }

  /** Every bubble whose DOM is in `messagesEl`; destroyed when that DOM is cleared. */
  private readonly mountedBubbles = new Set<AssistantBubble>();

  private destroyMountedBubbles(): void {
    for (const bubble of this.mountedBubbles) bubble.destroy();
    this.mountedBubbles.clear();
  }

  renderTranscript(messages: AgentMessage[]): void {
    this.destroyMountedBubbles();
    for (const segment of this.allSegments) segment.dispose();
    this.allSegments.clear();
    this.activity?.dispose();
    this.activity = null;
    this.turnSegments = [];
    this.segmentBubbles = [];
    this.turnBubbles = [];
    this.messagesEl.empty();
    this.reportSources.clear();
    this.bubble = null;
    this.lastBubbleError = undefined;
    this.turnUsage = null;
    const toolResults = collectToolResults(messages);
    const lastAssistant = lastIndex(messages, (message) => message.role === "assistant");
    let rendered = 0;
    messages.forEach((message, index) => {
      if (message.role === "user" && isSummaryMessage(message)) {
        // A compaction summary isn't a user turn: show it as a distinct,
        // non-editable block instead of an editable user bubble.
        this.renderSummaryMessage(messageText(message));
        rendered += 1;
      } else if (message.role === "user" && parseSubagentReport(messageText(message))) {
        // Close the turn before: the report's sources belong to the turn it starts.
        this.finishTurn();
        this.renderSubagentReport(messageText(message), true);
        rendered += 1;
      } else if (message.role === "user") {
        this.finishTurn();
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
    // A turn still in flight (a tab switch mid-run) keeps its activity open,
    // so the live steps that follow land in it.
    if (!(this.host.isStreaming?.() ?? false)) this.finishTurn();
    if (rendered === 0) this.host.renderEmptyState();
    this.scrollToBottom();
  }

  private renderAssistantMessage(
    message: AgentMessage,
    toolResults: Map<string, ToolResultLite>,
    isLast: boolean,
  ): void {
    if (!this.activity) this.startTurn(false);
    const bubble = this.newBubble();
    // Mirror the live path: every assistant turn gets its Thinking → Thought
    // status pill (mount eagerly, settle on finalize) so history replay renders
    // identically to the live stream for text-only turns too.
    bubble.beginThinking();
    const reasoning = thinkingText(message);
    if (reasoning) bubble.appendReasoning(reasoning);
    // The live order: the message's text, then its tool calls. A call after
    // text opens the next segment, below that text (U4 #1).
    this.applyAssistantMessage(bubble, message, { canRetry: isLast });
    for (const call of toolCalls(message)) {
      bubble.startStep(call.id, call.name, JSON.stringify(call.arguments ?? {}));
      this.applyApprovalRecord(call.id);
      const result = toolResults.get(call.id);
      // Pass the persisted details wrapped in the result shape endStep reads
      // (`resultObject.details`), so replay re-derives the live verdict — a
      // stopped subagent dispatch must render red here too, not green.
      if (result) {
        bubble.endStep(call.id, result.text, result.isError, { details: result.details });
        this.addToolResultUsage(result.details);
      }
    }
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
    options: { canRetry: boolean; live?: boolean },
  ): void {
    const usage = assistantUsage(message);
    if (usage) {
      this.turnUsage ??= emptyUsage();
      addUsage(this.turnUsage, usage);
    }
    const text = messageText(message);
    if (text) {
      void bubble.finalizeText(text, this.host.app, this.host.component);
      const elapsedMs = options.live && this.runStartedAt !== null ? performance.now() - this.runStartedAt : undefined;
      bubble.showActions({ canRetry: options.canRetry, meta: formatTurnMeta({ usage: this.turnUsage, elapsedMs }) });
    } else {
      bubble.finalizeWithoutText();
    }
    const errorMessage = (message as { errorMessage?: string }).errorMessage;
    if (errorMessage) {
      this.turnError = true;
      bubble.showError(errorMessage);
      if (options.canRetry) this.lastBubbleError = errorMessage;
    }
  }

  private renderUserMessage(
    text: string,
    attachments: ContextAttachment[],
    editIndex?: number,
    options: { forceScroll?: boolean; historyImages?: MessageImageLite[] } = {},
  ): void {
    this.turnUsage = null;
    const el = acHook(this.messagesEl.createDiv({ cls: ["agentic-chat-message", "agentic-chat-user"] }), "user-message");
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
            openVaultPath(this.host.app, path);
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

  /**
   * A subagent dispatch's children cost counts in this turn's footer (U4 #8).
   * Called with the tool result's `details`, live and on replay.
   */
  addToolResultUsage(details: unknown): void {
    const usage = subagentDetailsUsage(details);
    if (!usage) return;
    this.turnUsage ??= emptyUsage();
    addUsage(this.turnUsage, usage);
  }

  finalizeBubble(message: AgentMessage): void {
    const bubble = this.bubble;
    if (!bubble) return;
    this.applyAssistantMessage(bubble, message, { canRetry: true, live: true });
  }

  private newBubble(): AssistantBubble {
    const bubble = this.createBubble();
    this.mountedBubbles.add(bubble);
    this.turnBubbles.push(bubble);
    this.segmentBubbles.push(bubble);
    return bubble;
  }

  private createBubble(): AssistantBubble {
    let activity = this.activity ?? this.startTurn((this.host.isStreaming?.() ?? false));
    // The open segment already has text below it: this message's thoughts and
    // steps start the next segment, after that text.
    if (this.segmentBubbles.some((bubble) => bubble.hasText)) activity = this.openSegment();
    return new AssistantBubble(this.messagesEl, activity, {
      nextSegment: () => this.openSegment(),
      onRetry: () => this.host.retryLast(),
      onOpenExternalLink: (target) => void this.openRenderedExternalLink(target),
      onOpenNote: (path) => openVaultPath(this.host.app, path),
      onContentChange: () => this.scrollToBottom(),
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

  /**
   * The scroll queued for the next frame: `none`, `follow` (only if still
   * pinned to the bottom when the frame runs), or `force` (always). Calls in
   * the same frame coalesce, and `force` wins over `follow`.
   */
  private scheduledScroll: ScheduledScroll = "none";

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
    const alreadyScheduled = this.scheduledScroll !== "none";
    if (options.force) this.scheduledScroll = "force";
    else if (!alreadyScheduled) this.scheduledScroll = "follow";
    if (alreadyScheduled) return;
    window.requestAnimationFrame(() => {
      const force = this.scheduledScroll === "force";
      this.scheduledScroll = "none";
      if (!force && !this.autoScrollPinned) return;
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.autoScrollPinned = isPinnedToBottom(this.messagesEl);
    });
  }
}

type ScheduledScroll = "none" | "follow" | "force";

/** Index of the last element matching `predicate`, or -1. */
function lastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}
