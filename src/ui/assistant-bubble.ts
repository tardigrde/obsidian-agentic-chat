import { type App, type Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import { SUBAGENT_TOOL_NAME } from "../tools/subagent-tool";
import { callPath, formatElapsed, HIDE_RESULT_TOOLS, safeJson, truncateText } from "./format";
import {
  MAX_SOURCE_CHIPS,
  SOURCE_TOOLS,
  activeNotePathFromText,
  assistantImageSourcePath,
  enhanceCallouts,
  fixupRenderedAssistantImages,
  installRenderedLinkHandlers,
  isAskUserDetails,
  renderMermaidBlocks,
  rewriteAssistantMarkdownImages,
  sourceChipName,
} from "./assistant-markdown";
import {
  renderAskUserStep,
  renderCallSection,
  renderStepTitle,
  syncStepCollapsible,
  toggleStep,
} from "./step-card";
import {
  renderSubagentChildren,
  subagentChildren,
  subagentResultForcesError,
} from "./subagent-tree";

/** Per-step DOM + identity kept on the bubble for live updates and settle. */
interface StepEntry {
  card: HTMLElement;
  icon: HTMLElement;
  body: HTMLElement;
  name: string;
  startedAt: number;
}

export interface BubbleActions {
  /** Re-run the conversation's last user turn. */
  onRetry?: () => void;
  /** Open an external rendered link such as https://. */
  onOpenExternalLink?: (target: string) => void;
  /** Open a vault-relative note path shown in a tool-call section (e.g. read/write/edit target). */
  onOpenNote?: (path: string) => void;
  /** Called after buffered streaming text/reasoning mutates the bubble. */
  onContentChange?: () => void;
  /** Abort a single running subagent child by its stopId. */
  onStopSubagentChild?: (stopId: string) => void;
}

/** Owns the DOM of a single assistant turn: reasoning, tool steps, text, actions. */
export class AssistantBubble {
  private readonly el: HTMLElement;
  private readonly stepsEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private reasoningBody: HTMLElement | null = null;
  private reasoningDropped = false;
  private markdown = "";
  private readonly steps = new Map<string, StepEntry>();
  // Streaming deltas are buffered and flushed once per animation frame, so a fast
  // token stream causes one DOM mutation/reflow per frame instead of one per token.
  private pendingText = "";
  private pendingReasoning = "";
  private flushHandle: number | null = null;
  // Reasoning header state: the pill IS the turn's status — "Thinking" with a
  // pulsing dot while the model works, flipping to a green check "Thought" the
  // moment the answer starts streaming. Mounted eagerly at message_start.
  private reasoningLabelEl: HTMLElement | null = null;
  private reasoningDotEl: HTMLElement | null = null;
  private reasoningTimeEl: HTMLElement | null = null;
  private reasoningTimerHandle: number | null = null;
  private reasoningStart = 0;
  private reasoningSettled = false;
  // Distinct vault paths touched by tool calls this turn, rendered as source chips.
  private readonly sourcePaths = new Set<string>();
  // Per-step source path (for SOURCE_TOOLS) so an errored call can retract its chip.
  private readonly stepSourcePath = new Map<string, string>();
  // Guard so the settle/chip chrome runs once per bubble even when both the
  // text and no-text finalize paths (or a later agent_end) touch the same turn.
  private finalized = false;
  // Per-turn timeline (E10): reasoning trace + tool steps share one container with
  // a continuous left rail whose height is kept in sync via a ResizeObserver.
  private timelineEl: HTMLElement | null = null;
  private railEl: HTMLElement | null = null;
  private timelineObserver: ResizeObserver | null = null;

  constructor(
    parent: HTMLElement,
    private readonly actions: BubbleActions = {},
  ) {
    this.el = parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-assistant"] });
    this.textEl = this.el.createDiv({ cls: ["agentic-chat-text", "is-streaming", "is-empty"] });
    this.stepsEl = this.el.createDiv({ cls: "agentic-chat-steps" });
    this.actionsEl = this.el.createDiv({ cls: "agentic-chat-actions" });
  }

  /** Hide the transcript node when it holds no meaningful text (incl. whitespace-only). */
  private syncTextEmpty(): void {
    const empty = (this.textEl.textContent ?? "").trim().length === 0 && this.textEl.childElementCount === 0;
    this.textEl.toggleClass("is-empty", empty);
  }

  appendText(delta: string): void {
    // Ignore late deltas after the bubble has been finalized to rendered
    // markdown, so a stray event can't append raw text over the final output.
    if (this.markdown) return;
    this.pendingText += delta;
    // The answer has STARTED streaming → the reasoning trace is done. Settle the
    // pill now (green check "Thought") instead of waiting for agent_end, so a
    // turn with finished tools + streaming text never shows a purple "Thinking".
    if (this.reasoningBody && !this.reasoningSettled) this.settleReasoning();
    this.scheduleFlush();
  }

  appendReasoning(delta: string): void {
    // After an error dropped the empty pill, a late delta must not mount a
    // new "Thinking" pill that can never settle.
    if (this.markdown || this.reasoningDropped) return;
    if (!this.reasoningBody) this.ensureReasoningShell();
    this.pendingReasoning += delta;
    this.scheduleFlush();
  }

  /**
   * Mount the turn's status pill ("Thinking" · pulsing dot · live timer) at
   * message_start, before any reasoning or text has streamed. The reasoning
   * trace appears under it once thinking_delta arrives; on the first answer text
   * the pill settles to a green-check "Thought" (see settleReasoning).
   */
  beginThinking(): void {
    if (this.markdown || this.reasoningBody || this.reasoningDropped) return;
    this.ensureReasoningShell();
  }

  private ensureReasoningShell(): void {
    if (this.reasoningBody) return;
    const details = this.el.createEl("details", { cls: "agentic-chat-reasoning" });
    const summary = details.createEl("summary", { cls: "agentic-chat-reasoning-summary" });
    const chevron = summary.createSpan({ cls: "agentic-chat-reasoning-chevron" });
    setIcon(chevron, "chevron-right");
    const pill = summary.createSpan({ cls: "agentic-chat-reasoning-pill" });
    this.reasoningDotEl = pill.createSpan({ cls: "agentic-chat-reasoning-dot" });
    this.reasoningLabelEl = pill.createSpan({ cls: "agentic-chat-reasoning-label", text: "Thinking" });
    this.reasoningTimeEl = summary.createSpan({ cls: "agentic-chat-reasoning-time" });
    this.reasoningBody = details.createDiv({ cls: "agentic-chat-reasoning-body" });
    this.ensureTimeline();
    // Transcript text streams before tool execution (message_end precedes
    // tool_execution_start), so the text node lives before the steps node.
    // Insert reasoning at the top so order stays: reasoning → text → steps.
    const anchor = this.textEl.parentElement === this.timelineEl ? this.textEl : (this.timelineEl?.querySelector(".agentic-chat-steps") ?? null);
    if (anchor) this.timelineEl?.insertBefore(details, anchor);
    else this.timelineEl?.appendChild(details);
    this.reasoningStart = performance.now();
    this.reasoningTimerHandle = window.setInterval(() => {
      this.reasoningTimeEl?.setText(formatElapsed(performance.now() - this.reasoningStart));
    }, 100);
  }

  /** Schedule a single buffered flush on the next animation frame. */
  private scheduleFlush(): void {
    if (this.flushHandle !== null) return;
    this.flushHandle = window.requestAnimationFrame(() => {
      this.flushHandle = null;
      this.flushBuffers();
    });
  }

  /** Append all buffered stream deltas in one DOM mutation per surface. */
  private flushBuffers(): void {
    let changed = false;
    if (this.pendingText) {
      this.textEl.appendText(this.pendingText);
      this.pendingText = "";
      changed = true;
    }
    if (this.pendingReasoning && this.reasoningBody) {
      this.reasoningBody.appendText(this.pendingReasoning);
      this.pendingReasoning = "";
      changed = true;
    }
    if (changed) {
      this.syncTextEmpty();
      this.actions.onContentChange?.();
    }
  }

  /** Free live timers (reasoning) without touching the rendered DOM. */
  dispose(): void {
    this.stopReasoningTimer();
    // NOTE: the timeline ResizeObserver stays attached — history bubbles remain
    // interactive (reasoning/step toggles must keep the rail hugging content).
  }

  /** The bubble's DOM is gone: free the timers and the timeline observer. */
  destroy(): void {
    this.dispose();
    this.timelineObserver?.disconnect();
    this.timelineObserver = null;
  }

  /**
   * Lazily create the per-turn timeline container (reasoning + transcript text +
   * tool steps share one pixel rail). Order inside is reasoning → text → steps,
   * matching stream order: assistant text finalizes at message_end before
   * tool_execution_start adds step cards. Rail height tracks the container via
   * ResizeObserver so the line hugs the visible blocks whether they're
   * collapsed or expanded.
   */
  private ensureTimeline(): void {
    if (!this.timelineEl) {
      const timeline = this.el.createDiv({ cls: "agentic-chat-timeline" });
      this.railEl = timeline.createDiv({ cls: "agentic-chat-timeline-rail" });
      this.el.insertBefore(timeline, this.textEl);
      // Move the transcript node inside the timeline, ahead of the steps node,
      // so commentary renders above the tool call it introduces.
      timeline.appendChild(this.textEl);
      this.timelineEl = timeline;
      this.timelineObserver = new ResizeObserver(() => this.updateRail());
      this.timelineObserver.observe(timeline);
      this.updateRail();
    }
    if (this.stepsEl.parentElement !== this.timelineEl) this.timelineEl?.appendChild(this.stepsEl);
    // Keep text before steps even when startStep runs before any text streamed.
    if (this.textEl.parentElement === this.timelineEl && this.stepsEl.parentElement === this.timelineEl) {
      this.timelineEl.insertBefore(this.textEl, this.stepsEl);
    }
    this.syncTextEmpty();
  }

  private updateRail(): void {
    if (!this.timelineEl || !this.railEl) return;
    this.railEl.style.height = `${this.timelineEl.clientHeight}px`;
  }

  /** Stop the reasoning elapsed timer, keeping the last rendered value. */
  private stopReasoningTimer(): void {
    if (this.reasoningTimerHandle !== null) {
      window.clearInterval(this.reasoningTimerHandle);
      this.reasoningTimerHandle = null;
    }
  }

  /**
   * A failed turn with no reasoning trace must not keep a green-check "Thought"
   * pill: it reads as success right above the error. Remove the empty shell.
   */
  private dropEmptyReasoning(): void {
    if (!this.reasoningBody) return;
    // Deltas wait for the next frame; history replay and a same-frame error
    // reach here before the flush, so count the buffer as content too.
    if (this.pendingReasoning.trim() || this.reasoningBody.textContent?.trim()) return;
    this.reasoningDropped = true;
    this.stopReasoningTimer();
    this.reasoningBody.closest("details")?.remove();
    this.reasoningBody = null;
    this.reasoningLabelEl = null;
    this.reasoningDotEl = null;
    this.reasoningTimeEl = null;
  }

  /**
   * Settle the reasoning header into its done state: one stable label, green
   * check capsule, and (for a live turn) the final elapsed time. Idempotent —
   * can be triggered early by the first streamed answer text, or late by an
   * agent_end / no-text finalize.
   */
  private settleReasoning(): void {
    this.stopReasoningTimer();
    if (this.reasoningSettled || !this.reasoningBody) return;
    this.reasoningSettled = true;
    const elapsed = performance.now() - this.reasoningStart;
    this.reasoningLabelEl?.setText("Thought");
    // A live stream keeps the final elapsed time; a near-instant/static trace
    // (history re-render) shows none.
    this.reasoningTimeEl?.setText(elapsed < 100 ? "" : formatElapsed(elapsed));
    // Same "completed" primitive as tool steps: green-tint capsule + check.
    if (this.reasoningDotEl) setIcon(this.reasoningDotEl, "check-circle-2");
    this.reasoningBody.closest("details")?.addClass("is-done");
  }

  startStep(id: string, name: string, rawArgs: string): void {
    // A step is a manual collapsible row sharing ONE anatomy with the reasoning
    // pill: [‹ chevron] [card]. Only the outside chevron toggles the body — so a
    // clickable path inside the header navigates without collapsing the step.
    // Raw arg JSON is never shown inline.
    const row = this.stepsEl.createDiv({ cls: "agentic-chat-step-row" });
    const toggle = row.createSpan({
      cls: "agentic-chat-step-toggle",
      attr: { role: "button", tabindex: "0", "aria-expanded": "false", "aria-label": "Toggle details" },
    });
    const chevron = toggle.createSpan({ cls: "agentic-chat-step-chevron" });
    setIcon(chevron, "chevron-right");
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleStep(row);
    });
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleStep(row);
      }
    });
    const card = row.createDiv({ cls: ["agentic-chat-step", "is-running"] });
    const header = card.createDiv({ cls: "agentic-chat-step-header" });
    const icon = header.createSpan({ cls: "agentic-chat-step-icon" });
    setIcon(icon, "loader-2");
    const nameEl = header.createSpan({ cls: "agentic-chat-step-name" });
    renderStepTitle(nameEl, name, rawArgs, this.actions.onOpenNote);
    if (name.startsWith("mcp__")) nameEl.setAttr("title", name);
    const body = card.createDiv({ cls: "agentic-chat-step-body" });
    renderCallSection(body, name, rawArgs);
    syncStepCollapsible(row, body);
    this.ensureTimeline();
    this.steps.set(id, { card, icon, body, name, startedAt: performance.now() });
    // Record the tool's vault target (if any) so finalized turns can surface a
    // compact list of source files as chips under the response text. Only
    // read-style tools count as sources — writes are outputs, deletes/renames
    // point at moved paths, and ls targets a folder. The per-step path lets an
    // errored call revoke its chip (a failed read is NOT a citation).
    if (SOURCE_TOOLS.has(name)) {
      const path = callPath(rawArgs);
      if (path) {
        this.sourcePaths.add(path);
        this.stepSourcePath.set(id, path);
      }
    }
  }

  /**
   * Live update for a running tool step. Currently renders subagent child
   * progress (a collapsed-per-child, expandable tree) as the dispatch runs.
   */
  updateStep(id: string, partial: unknown): void {
    const step = this.steps.get(id);
    if (!step) return;
    const details = (partial as { details?: unknown } | undefined)?.details;
    const children = subagentChildren(details);
    if (children.length > 0) {
      renderSubagentChildren(step.body, children, this.actions.onStopSubagentChild);
      if (step.card.parentElement) syncStepCollapsible(step.card.parentElement, step.body);
      // Auto-open so live child progress is visible while the step runs.
      step.card.addClass("is-open");
      step.card.parentElement?.addClass("is-open");
      step.card.parentElement?.querySelector(".agentic-chat-step-toggle")?.setAttribute("aria-expanded", "true");
      return;
    }
    if (isAskUserDetails(details)) {
      renderAskUserStep(step.body, details);
      if (step.card.parentElement) syncStepCollapsible(step.card.parentElement, step.body);
      // Auto-open so the ask-user state is visible while waiting.
      step.card.addClass("is-open");
      step.card.parentElement?.addClass("is-open");
      step.card.parentElement?.querySelector(".agentic-chat-step-toggle")?.setAttribute("aria-expanded", "true");
    }
  }

  endStep(id: string, result: string, isError: boolean, resultObject?: unknown): void {
    const step = this.steps.get(id);
    if (!step) return;
    const failed = isError || (step.name === SUBAGENT_TOOL_NAME && subagentResultForcesError(resultObject));
    // Replay path: `ChatView.renderAssistantMessage` only calls startStep+endStep,
    // so the dispatch card would stay empty without this.
    if (step.name === SUBAGENT_TOOL_NAME) this.renderReplayedSubagent(step, resultObject);
    this.markStepSettled(step, failed);
    // get_active_note carries its target path in the RESULT, not the args, so
    // harvest it here (startStep can only see args). Live calls pass the raw
    // result object; history replay passes only the rendered text, whose first
    // line is `Active note: <path>` — parse that so replay chips match live.
    if (!failed) this.harvestActiveNotePath(step, result, resultObject, id);
    // A failed tool call is not a citation: retract its source chip and keep the
    // step expanded so the human can see WHY it failed (no hidden error reason).
    if (failed) this.retractFailedSource(step, id);
    this.renderStepResult(step, result, failed);
    const row = step.card.parentElement;
    if (row) syncStepCollapsible(row, step.body);
  }

  /**
   * Render persisted Dispatch children without auto-opening the outer card —
   * reload shows a collapsed card for `done` (Codex `ReplayKind` parity) while
   * live `updateStep` already auto-opened.
   */
  private renderReplayedSubagent(step: StepEntry, resultObject: unknown): void {
    const maybeDetails = (resultObject as { details?: unknown } | undefined)?.details;
    const children = subagentChildren(maybeDetails);
    if (children.length === 0) return;
    renderSubagentChildren(step.body, children, this.actions.onStopSubagentChild);
    const row = step.card.parentElement;
    if (row) syncStepCollapsible(row, step.body);
  }

  private markStepSettled(step: StepEntry, isError: boolean): void {
    step.card.removeClass("is-running");
    step.card.addClass(isError ? "is-error" : "is-done");
    setIcon(step.icon, isError ? "x-circle" : "check-circle-2");
    // Per-step elapsed time, surfaced once the step settles.
    step.card.querySelector(".agentic-chat-step-header")?.createSpan({
      cls: "agentic-chat-step-time",
      text: formatElapsed(performance.now() - step.startedAt),
    });
  }

  /**
   * Result/Error as a body section. A read/write/get_active_note success result
   * is just file contents (already on disk / in context), so hide it; errors
   * always show.
   */
  private renderStepResult(step: StepEntry, result: string, isError: boolean): void {
    if (!isError && HIDE_RESULT_TOOLS.has(step.name)) return;
    const resultSection = step.body.createDiv({ cls: "agentic-chat-step-result" });
    resultSection.createDiv({ cls: "agentic-chat-step-section-label", text: isError ? "Error" : "Result" });
    resultSection.createEl("pre", { text: truncateText(result, 4_000) });
  }

  /** Record a successful get_active_note's target as a source chip. */
  private harvestActiveNotePath(step: StepEntry, result: string, resultObject: unknown, id: string): void {
    if (step.name !== "get_active_note") return;
    const fromObject = resultObject !== undefined ? callPath(safeJson(resultObject)) : "";
    const path = fromObject || activeNotePathFromText(result);
    if (path) {
      this.sourcePaths.add(path);
      this.stepSourcePath.set(id, path);
    }
  }

  /** A failed call is not a citation: revoke its source chip and expand the step. */
  private retractFailedSource(step: StepEntry, id: string): void {
    const sourcePath = this.stepSourcePath.get(id);
    if (sourcePath) this.sourcePaths.delete(sourcePath);
    step.card.addClass("is-open");
    step.card.parentElement?.addClass("is-open");
    step.card.parentElement?.querySelector(".agentic-chat-step-toggle")?.setAttribute("aria-expanded", "true");
  }

  async finalizeText(markdown: string, app: App, component: Component): Promise<void> {
    // Commit any buffered deltas (so streamed reasoning isn't lost) and cancel the
    // pending frame before replacing the streamed text with rendered markdown.
    if (this.flushHandle !== null) {
      window.cancelAnimationFrame(this.flushHandle);
      this.flushHandle = null;
    }
    this.flushBuffers();
    this.markdown = markdown;
    this.textEl.empty();
    this.textEl.removeClass("is-streaming");
    this.textEl.addClass("markdown-rendered");
    // Settle chrome synchronously (before any await) so a later agent_end can
    // never double-settle or stamp the timers at a stale moment. Idempotent via
    // the finalized guard.
    this.finalizeChrome();
    // Vault-local images need a real sourcePath: "" leaves ![[pic.png]] embeds
    // and vault-relative ![](path/pic.png) destinations unresolved. Rewrite
    // resolvable ones to resource URLs up front, then fix up whatever the
    // renderer still leaves behind (relative <img> srcs, unresolved embeds).
    const sourcePath = assistantImageSourcePath(app);
    const rewritten = rewriteAssistantMarkdownImages(app, markdown, sourcePath);
    await MarkdownRenderer.render(app, rewritten, this.textEl, sourcePath, component);
    fixupRenderedAssistantImages(this.textEl, app, sourcePath);
    enhanceCallouts(this.textEl);
    installRenderedLinkHandlers(this.textEl, app, this.actions.onOpenExternalLink);
    await renderMermaidBlocks(this.textEl);
    this.syncTextEmpty();
  }

  /**
   * Settle a turn that produced no rendered text (abort, model error, or a
   * text-less tool-only message): stop live timers and flip the reasoning pill
   * to its static state, but never render markdown. Idempotent.
   */
  finalizeWithoutText(): void {
    this.syncTextEmpty();
    this.finalizeChrome();
  }

  /** One-time settle of the turn chrome (reasoning pill + source chips). */
  private finalizeChrome(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.settleReasoning();
    this.renderSourceChips();
  }

  /**
   * Render the per-turn source chips (vault files the tool calls touched) under
   * the finalized text. Deduped, capped, clickable → onOpenNote.
   */
  private renderSourceChips(): void {
    if (this.sourcePaths.size === 0) return;
    const container = this.el.createDiv({ cls: "agentic-chat-sources" });
    container.createSpan({ cls: "agentic-chat-sources-label", text: "Sources" });
    const paths = [...this.sourcePaths].slice(0, MAX_SOURCE_CHIPS);
    for (const path of paths) {
      const chip = container.createEl("button", {
        cls: "agentic-chat-source-chip",
        attr: { type: "button", title: path, "aria-label": `Open ${path}` },
      });
      const icon = chip.createSpan({ cls: "agentic-chat-source-chip-icon" });
      setIcon(icon, "file-text");
      chip.createSpan({ cls: "agentic-chat-source-chip-name", text: sourceChipName(path) });
      chip.addEventListener("click", () => this.actions.onOpenNote?.(path));
    }
    const remaining = this.sourcePaths.size - paths.length;
    if (remaining > 0) {
      container.createSpan({ cls: "agentic-chat-sources-more", text: `+${remaining}` });
    }
    this.el.insertBefore(container, this.actionsEl);
  }

  /**
   * Render a single clean error alert. A short message is a flat one-line banner;
   * a multi-line trace collapses into a `<details>` so it can't dominate the turn.
   * Idempotent: skips when an identical banner is already shown (avoids the
   * "Request was aborted" banner + matching step-error duplicate).
   */
  showError(message: string): void {
    const text = message.trim();
    if (!text) return;
    this.dropEmptyReasoning();
    const existing = this.el.querySelector(".agentic-chat-error");
    if (existing?.getAttr("data-error-text") === text) return;
    const banner = this.el.createDiv({ cls: "agentic-chat-error" });
    banner.setAttr("data-error-text", text);
    if (text.includes("\n")) {
      const details = banner.createEl("details", { cls: "agentic-chat-error-details" });
      details.createEl("summary", { text: text.split("\n", 1)[0] });
      details.createEl("pre", { text });
    } else {
      banner.setText(text);
    }
    // A text+error turn already carries the "Ask again" action row; only add an
    // inline banner Retry for text-less failures so there is one action, one way.
    if (this.actions.onRetry && !this.markdown) {
      const retry = banner.createEl("button", {
        cls: "agentic-chat-error-retry",
        attr: { type: "button", "aria-label": "Retry the failed request" },
      });
      const icon = retry.createSpan();
      setIcon(icon, "refresh-cw");
      retry.createSpan({ text: "Retry" });
      retry.addEventListener("click", () => this.actions.onRetry?.());
    }
    this.el.insertBefore(banner, this.actionsEl);
  }

  /** Render the inline action row (copy, retry). Safe to call once. */
  showActions(opts: { canRetry: boolean }): void {
    if (this.actionsEl.childElementCount > 0) return;
    if (!this.markdown.trim()) return;
    this.actionButton("copy", "Copy response", () => void this.copy());
    if (opts.canRetry && this.actions.onRetry) {
      this.actionButton("refresh-cw", "Ask again", this.actions.onRetry);
    }
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
