import { type App, type Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import {
  MAX_SOURCE_CHIPS,
  assistantImageSourcePath,
  enhanceCallouts,
  fixupRenderedAssistantImages,
  installRenderedLinkHandlers,
  isAskUserDetails,
  renderMermaidBlocks,
  rewriteAssistantMarkdownImages,
  sourceChipName,
} from "./assistant-markdown";
import type { ActivityLine, ReasoningEntry } from "./activity-line";
import { acHook } from "./test-hooks";
import type { AskUserDetails } from "../tools/ask-user-tool";

export interface BubbleActions {
  /** Re-run the conversation's last user turn. */
  onRetry?: () => void;
  /** Open an external rendered link such as https://. */
  onOpenExternalLink?: (target: string) => void;
  /** Open a vault-relative note path (a source chip). */
  onOpenNote?: (path: string) => void;
  /** Called after buffered streaming text/reasoning mutates the bubble. */
  onContentChange?: () => void;
  /**
   * A tool call after this message's text: open the next timeline segment
   * (U4 #1), so the row shows below the text it followed.
   */
  nextSegment?: () => ActivityLine;
}

/**
 * Lifecycle of one assistant message's reasoning ("Thinking" -> "Thought").
 * The reasoning renders as an entry in the turn's activity line.
 *
 *   none ──beginThinking / first reasoning delta──▶ thinking
 *   thinking ──first answer text / finalize──▶ thought
 *   thinking | thought ──error with an empty trace──▶ dropped
 *
 * `dropped` is terminal: a late delta must not mount an entry that can never
 * settle. The entry's DOM exists exactly in `thinking` and `thought`.
 */
export type ReasoningPillPhase = "none" | "thinking" | "thought" | "dropped";

/**
 * Owns the DOM of one assistant message: its text, error, sources, and turn
 * actions. Tool steps and reasoning go to the turn's activity line, which all
 * assistant messages of one turn share.
 */
export class AssistantBubble {
  private readonly el: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private reasoning: ReasoningEntry | null = null;
  private reasoningPhaseValue: ReasoningPillPhase = "none";
  private markdown = "";
  // Streaming deltas are buffered and flushed once per animation frame, so a fast
  // token stream causes one DOM mutation/reflow per frame instead of one per token.
  private pendingText = "";
  private pendingReasoning = "";
  private flushHandle: number | null = null;
  private finalized = false;

  // Segments this message wrote steps into; a step's later events go to its own.
  private readonly segments: ActivityLine[] = [];
  private pastText = false;
  // The segment that holds this message's reasoning row.
  private reasoningSegment: ActivityLine | null = null;

  constructor(
    parent: HTMLElement,
    private activityValue: ActivityLine,
    private readonly actions: BubbleActions = {},
  ) {
    this.segments.push(activityValue);
    this.el = acHook(parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-assistant"] }), "assistant-message");
    this.textEl = acHook(this.el.createDiv({ cls: ["agentic-chat-text", "is-streaming", "is-empty"] }), "assistant-text");
    this.actionsEl = acHook(this.el.createDiv({ cls: "agentic-chat-actions" }), "turn-actions");
  }

  /** The segment this message writes new steps into. */
  get activity(): ActivityLine {
    return this.activityValue;
  }

  private segmentOf(id: string): ActivityLine {
    return this.segments.find((segment) => segment.hasStep(id)) ?? this.activityValue;
  }

  /** Where this message's reasoning is in its lifecycle. */
  get reasoningPhase(): ReasoningPillPhase {
    return this.reasoningPhaseValue;
  }

  /** Whether the message rendered any answer text. */
  get hasText(): boolean {
    return this.markdown.trim().length > 0;
  }

  /** Hide the text node when it holds no meaningful text (incl. whitespace-only). */
  private syncTextEmpty(): void {
    const empty = (this.textEl.textContent ?? "").trim().length === 0 && this.textEl.childElementCount === 0;
    this.textEl.toggleClass("is-empty", empty);
    this.el.toggleClass("is-empty", empty && this.actionsEl.childElementCount === 0 && !this.el.querySelector(".agentic-chat-error, .agentic-chat-sources"));
  }

  appendText(delta: string): void {
    // Late deltas after the final render must not append raw text over it.
    if (this.markdown) return;
    this.pendingText += delta;
    // The answer has started, so the reasoning is done.
    if (this.reasoningPhaseValue === "thinking") this.settleReasoning();
    this.scheduleFlush();
  }

  appendReasoning(delta: string): void {
    // After an error dropped the empty entry, a late delta must not remount it.
    if (this.markdown || this.reasoningPhaseValue === "dropped") return;
    if (this.reasoningPhaseValue === "none") this.ensureReasoning();
    this.pendingReasoning += delta;
    this.scheduleFlush();
  }

  /** message_start: the message is thinking until text or reasoning arrives. */
  beginThinking(): void {
    if (this.markdown || this.reasoningPhaseValue !== "none") return;
    this.ensureReasoning();
  }

  private ensureReasoning(): void {
    if (this.reasoningPhaseValue !== "none") return;
    this.reasoningPhaseValue = "thinking";
    this.reasoningSegment = this.activity;
    this.reasoning = this.activity.addReasoning();
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== null) return;
    this.flushHandle = window.requestAnimationFrame(() => {
      this.flushHandle = null;
      this.flushBuffers();
    });
  }

  private flushBuffers(): void {
    let changed = false;
    if (this.pendingText) {
      this.textEl.appendText(this.pendingText);
      this.pendingText = "";
      changed = true;
    }
    if (this.pendingReasoning && this.reasoning) {
      this.reasoning.append(this.pendingReasoning);
      this.pendingReasoning = "";
      (this.reasoningSegment ?? this.activity).touch();
      changed = true;
    }
    if (changed) {
      this.syncTextEmpty();
      this.actions.onContentChange?.();
    }
  }

  /** Free live timers without touching the rendered DOM. */
  dispose(): void {
    if (this.flushHandle !== null) {
      window.cancelAnimationFrame(this.flushHandle);
      this.flushHandle = null;
      this.flushBuffers();
    }
  }

  /** The bubble's DOM is gone. */
  destroy(): void {
    this.dispose();
  }

  /**
   * A failed message with no reasoning trace must not keep an empty "Thought"
   * entry next to the error. Remove the empty entry for good.
   */
  private dropEmptyReasoning(): void {
    if (!this.reasoning || (this.reasoningPhaseValue !== "thinking" && this.reasoningPhaseValue !== "thought")) return;
    // Deltas wait for the next frame; replay and a same-frame error reach here
    // before the flush, so count the buffer as content too.
    if (this.pendingReasoning.trim() || this.reasoning.text.trim()) return;
    this.reasoningPhaseValue = "dropped";
    this.reasoning.remove();
    this.reasoning = null;
    (this.reasoningSegment ?? this.activity).touch();
  }

  /** Settle the reasoning entry (`Thought for 3s:`). Idempotent. */
  private settleReasoning(): void {
    if (this.reasoningPhaseValue !== "thinking" || !this.reasoning) return;
    this.reasoningPhaseValue = "thought";
    this.reasoning.settle();
    (this.reasoningSegment ?? this.activity).touch();
  }

  startStep(id: string, name: string, rawArgs: string): void {
    // A tool call means the text before it is done; settle the reasoning too.
    if (this.reasoningPhaseValue === "thinking" && (this.pendingReasoning.trim() || this.reasoning?.text.trim())) this.settleReasoning();
    // Text then a tool call: the row belongs below the text, in a new segment.
    if (this.hasText && !this.pastText && this.actions.nextSegment) {
      this.pastText = true;
      this.activityValue = this.actions.nextSegment();
      this.segments.push(this.activityValue);
    }
    this.activityValue.startStep(id, name, rawArgs);
  }

  updateStep(id: string, partial: unknown): void {
    this.segmentOf(id).updateStep(id, partial);
  }

  endStep(id: string, result: string, isError: boolean, resultObject?: unknown): void {
    this.segmentOf(id).endStep(id, result, isError, resultObject);
    const details = (resultObject as { details?: unknown } | undefined)?.details;
    if (isAskUserDetails(details) && details.status === "answered") this.renderAnsweredQuestion(details);
  }

  /**
   * An answered ask_user stays in the transcript where it happened: right
   * after the text this message wrote before the call, not only in the turn's
   * activity line above that text (U3 #15).
   */
  private renderAnsweredQuestion(details: AskUserDetails): void {
    let anchor: Element = this.el;
    while (anchor.nextElementSibling?.classList.contains("agentic-chat-ask-record")) anchor = anchor.nextElementSibling;
    const record = acHook(createDiv({ cls: ["agentic-chat-message", "agentic-chat-ask-record"] }), "ask-record");
    record.createSpan({ cls: "agentic-chat-ask-record-label", text: "Asked you" });
    record.createSpan({ cls: "agentic-chat-ask-record-question", text: details.question });
    if (details.answer) {
      record.createSpan({ cls: "agentic-chat-ask-record-label", text: "You answered" });
      record.createSpan({ cls: "agentic-chat-ask-record-answer", text: details.answer });
    }
    anchor.after(record);
  }

  async finalizeText(markdown: string, app: App, component: Component): Promise<void> {
    // Commit buffered deltas (so streamed reasoning is not lost) before the
    // streamed text is replaced with rendered markdown.
    if (this.flushHandle !== null) {
      window.cancelAnimationFrame(this.flushHandle);
      this.flushHandle = null;
    }
    this.flushBuffers();
    this.markdown = markdown;
    this.textEl.empty();
    this.textEl.removeClass("is-streaming");
    this.textEl.addClass("markdown-rendered");
    this.finalizeChrome();
    const sourcePath = assistantImageSourcePath(app);
    const rewritten = rewriteAssistantMarkdownImages(app, markdown, sourcePath);
    await MarkdownRenderer.render(app, rewritten, this.textEl, sourcePath, component);
    fixupRenderedAssistantImages(this.textEl, app, sourcePath);
    enhanceCallouts(this.textEl);
    installRenderedLinkHandlers(this.textEl, app, this.actions.onOpenExternalLink);
    await renderMermaidBlocks(this.textEl);
    this.syncTextEmpty();
  }

  /** Settle a message that rendered no text (tool call, abort, error). Idempotent. */
  finalizeWithoutText(): void {
    if (this.flushHandle !== null) {
      window.cancelAnimationFrame(this.flushHandle);
      this.flushHandle = null;
    }
    this.flushBuffers();
    this.syncTextEmpty();
    this.finalizeChrome();
  }

  private finalizeChrome(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.settleReasoning();
  }

  /** The turn's source chips (files its tools read), under the final answer. */
  renderSourceChips(paths: ReadonlySet<string>): void {
    if (paths.size === 0 || this.el.querySelector(".agentic-chat-sources")) return;
    const container = this.el.createDiv({ cls: "agentic-chat-sources", attr: { role: "group", "aria-label": "Sources" } });
    const shown = [...paths].slice(0, MAX_SOURCE_CHIPS);
    for (const path of shown) {
      const chip = container.createEl("button", {
        cls: "agentic-chat-source-chip",
        attr: { type: "button", title: path, "aria-label": `Open ${path}` },
      });
      const icon = chip.createSpan({ cls: "agentic-chat-source-chip-icon" });
      setIcon(icon, "file-text");
      chip.createSpan({ cls: "agentic-chat-source-chip-name", text: sourceChipName(path) });
      chip.addEventListener("click", () => this.actions.onOpenNote?.(path));
    }
    const remaining = paths.size - shown.length;
    if (remaining > 0) container.createSpan({ cls: "agentic-chat-sources-more", text: `+${remaining}` });
    this.el.insertBefore(container, this.actionsEl);
    this.syncTextEmpty();
  }

  /**
   * One error block: the red tint and an alert icon. A multi-line trace folds
   * into a `<details>`. Skips a duplicate of the same text.
   */
  showError(message: string): void {
    const text = message.trim();
    if (!text) return;
    this.dropEmptyReasoning();
    const existing = this.el.querySelector(".agentic-chat-error");
    if (existing?.getAttr("data-error-text") === text) return;
    const banner = acHook(this.el.createDiv({ cls: "agentic-chat-error" }), "turn-error");
    banner.setAttr("data-error-text", text);
    const errorIcon = banner.createSpan({ cls: "agentic-chat-error-icon", attr: { "aria-hidden": "true" } });
    setIcon(errorIcon, "alert-circle");
    const errorBody = banner.createDiv({ cls: "agentic-chat-error-body" });
    if (text.includes("\n")) {
      const details = errorBody.createEl("details", { cls: "agentic-chat-error-details" });
      details.createEl("summary", { text: text.split("\n", 1)[0] });
      details.createEl("pre", { text });
    } else {
      errorBody.createDiv({ cls: "agentic-chat-error-text", text });
    }
    // A text+error turn already has "Ask again" in its actions; only a
    // text-less failure gets the inline Retry.
    if (this.actions.onRetry && !this.markdown) {
      const retry = errorBody.createEl("button", {
        cls: "agentic-chat-error-retry",
        attr: { type: "button", "aria-label": "Retry the failed request" },
      });
      const icon = retry.createSpan();
      setIcon(icon, "refresh-cw");
      retry.createSpan({ text: "Retry" });
      retry.addEventListener("click", () => this.actions.onRetry?.());
    }
    this.el.insertBefore(banner, this.actionsEl);
    this.syncTextEmpty();
  }

  /**
   * Render the turn actions (copy, retry) and the per-answer meta
   * (`6s · 4.1k tokens · $0.004`). Safe to call once.
   */
  showActions(opts: { canRetry: boolean; meta?: string }): void {
    if (this.actionsEl.childElementCount > 0) return;
    if (!this.markdown.trim()) return;
    this.actionButton("copy", "Copy response", () => void this.copy());
    if (opts.canRetry && this.actions.onRetry) {
      this.actionButton("refresh-cw", "Ask again", this.actions.onRetry);
    }
    if (opts.meta) acHook(this.actionsEl.createSpan({ cls: "agentic-chat-turn-meta", text: opts.meta }), "turn-meta");
    this.syncTextEmpty();
  }

  /** Replace the meta (the turn's totals grow as later messages arrive). */
  setMeta(meta: string): void {
    const el = this.actionsEl.querySelector(".agentic-chat-turn-meta");
    if (el) el.setText(meta);
  }

  private actionButton(icon: string, label: string, onClick: () => void): void {
    const button = this.actionsEl.createEl("button", {
      cls: ["clickable-icon", "agentic-chat-action"],
      attr: { "aria-label": label },
    });
    setIcon(button, icon);
    button.addEventListener("click", onClick);
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.markdown);
      new Notice("Response copied.");
    } catch {
      new Notice("Could not copy to clipboard.");
    }
  }
}
