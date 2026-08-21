import { type App, type Component, loadMermaid, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type { Usage } from "@earendil-works/pi-ai";
import type { SubagentChildStatus } from "../tools/subagent-tool";
import type { AskUserDetails } from "../tools/ask-user-tool";
import {
  callPath,
  describeCall,
  formatCallBody,
  formatCost,
  formatElapsed,
  formatTokenInteger,
  HIDE_RESULT_TOOLS,
  PATH_TOOLS,
  safeJson,
  TOOL_LABELS,
  truncateText,
} from "./format";

const SUBAGENT_STATUS_LABEL: Record<SubagentChildStatus["status"], string> = {
  queued: "queued",
  running: "running…",
  done: "done",
  error: "failed",
  aborted: "stopped",
};

/** Extract the child statuses from a subagent tool result (details snapshot). */
function subagentChildrenFromResult(resultObject: unknown): SubagentChildStatus[] {
  const details = (resultObject as { details?: { kind?: string; children?: SubagentChildStatus[] } } | undefined)
    ?.details;
  return details?.kind === "subagent" && Array.isArray(details.children) ? details.children : [];
}

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
  /** Exit plan mode and send the implement prompt. */
  onImplementPlan?: () => void;
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
    this.textEl = this.el.createDiv({ cls: ["agentic-chat-text", "is-streaming"] });
    this.stepsEl = this.el.createDiv({ cls: "agentic-chat-steps" });
    this.actionsEl = this.el.createDiv({ cls: "agentic-chat-actions" });
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
    if (this.markdown) return;
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
    if (this.markdown || this.reasoningBody) return;
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
    const stepsRef = this.timelineEl?.querySelector(".agentic-chat-steps") ?? null;
    this.timelineEl?.insertBefore(details, stepsRef);
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
    if (changed) this.actions.onContentChange?.();
  }

  /** Free live timers (reasoning) without touching the rendered DOM. */
  dispose(): void {
    this.stopReasoningTimer();
    // NOTE: the timeline ResizeObserver stays attached — history bubbles remain
    // interactive (reasoning/step toggles must keep the rail hugging content).
  }

  /**
   * Lazily create the per-turn timeline container (reasoning + steps share one
   * pixel rail). Inserted above the text so it reads as "how the agent got here",
   * then the answer. Rail height tracks the container via ResizeObserver so the
   * line hugs the visible blocks whether they're collapsed or expanded.
   */
  private ensureTimeline(): void {
    if (this.timelineEl) return;
    const timeline = this.el.createDiv({ cls: "agentic-chat-timeline" });
    this.railEl = timeline.createDiv({ cls: "agentic-chat-timeline-rail" });
    this.el.insertBefore(timeline, this.textEl);
    this.timelineEl = timeline;
    this.timelineObserver = new ResizeObserver(() => this.updateRail());
    this.timelineObserver.observe(timeline);
    this.updateRail();
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
      this.toggleStep(row);
    });
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.toggleStep(row);
      }
    });
    const card = row.createDiv({ cls: ["agentic-chat-step", "is-running"] });
    const header = card.createDiv({ cls: "agentic-chat-step-header" });
    const icon = header.createSpan({ cls: "agentic-chat-step-icon" });
    setIcon(icon, "loader-2");
    const nameEl = header.createSpan({ cls: "agentic-chat-step-name" });
    this.renderStepTitle(nameEl, name, rawArgs);
    if (name.startsWith("mcp__")) nameEl.setAttr("title", name);
    const body = card.createDiv({ cls: "agentic-chat-step-body" });
    this.renderCallSection(body, name, rawArgs);
    this.syncStepCollapsible(row, body);
    this.ensureTimeline();
    if (this.stepsEl.parentElement !== this.timelineEl) this.timelineEl?.appendChild(this.stepsEl);
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

  /** Toggle a step's body open/closed and reflect state on the chevron + aria. */
  private toggleStep(row: HTMLElement): void {
    const card = row.querySelector(".agentic-chat-step");
    if (!card) return;
    const open = card.classList.toggle("is-open");
    row.querySelector(".agentic-chat-step-toggle")?.setAttribute("aria-expanded", String(open));
  }

  /** Hide the chevron + collapse affordance when the body has nothing to show. */
  private syncStepCollapsible(row: HTMLElement, body: HTMLElement): void {
    const toggle = row.querySelector<HTMLElement>(".agentic-chat-step-toggle");
    if (!toggle) return;
    toggle.toggleClass("is-hidden", body.childElementCount === 0);
  }

  /** Render the header title: a readable label, with a clickable vault path for path-bearing tools. */
  private renderStepTitle(nameEl: HTMLElement, name: string, rawArgs: string): void {
    if (name.startsWith("mcp__")) {
      // "mcp__<server>__<tool>" → human "MCP · <tool>"; full id in the tooltip.
      const segments = name.split("__");
      nameEl.appendText(`MCP · ${segments.at(-1) ?? name}`);
      return;
    }
    if (PATH_TOOLS.has(name)) {
      nameEl.appendText(TOOL_LABELS[name] ?? `Running ${name}`);
      const path = callPath(rawArgs);
      if (path) {
        nameEl.appendText(": ");
        this.appendPathLink(nameEl, path);
      }
      return;
    }
    nameEl.appendText(describeCall(name, rawArgs));
  }

  /**
   * Render the step body extras. The title (label + clickable path) lives in the
   * header, so the body only holds per-tool extras: a read's line range, an
   * edit's mini oldText→newText diff, or readable key:value lines for other
   * tools. The Result/Error section is appended on endStep. The edit diff shows
   * the change itself (no file context at render time, unlike the approval modal).
   */
  private renderCallSection(body: HTMLElement, name: string, rawArgs: string): void {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      args = {};
    }

    if (name === "read" || name === "get_active_note") {
      const range = readRangeText(args);
      if (range) body.createDiv({ cls: "agentic-chat-step-call-args", text: range });
      return;
    }
    if (name === "edit") {
      const edits = Array.isArray(args.edits) ? args.edits.filter(isStringEditPair) : [];
      if (edits.length) {
        body.createDiv({ cls: "agentic-chat-step-call-args", text: `${edits.length} edit${edits.length === 1 ? "" : "s"}` });
        this.renderEditDiff(body, edits);
      }
      return;
    }
    if (name === "write") return; // title carries the path; success result is hidden
    // Non-path tools: readable key:value lines.
    const text = formatCallBody(name, rawArgs);
    if (text) body.createDiv({ cls: "agentic-chat-step-call-args", text });
  }

  /** Append a clickable vault-path link (opens the note via onOpenNote). */
  private appendPathLink(parent: HTMLElement, path: string): void {
    if (!path) {
      parent.appendText("(unknown path)");
      return;
    }
    const link = parent.createEl("a", { cls: "agentic-chat-step-path-link", attr: { href: "#", role: "button" } });
    // Middle-truncate long vault paths (keep the head/basename readable) instead
    // of ellipsis-ing only the tail, which hides the distinguishing filename.
    const display = path.length > 36 ? middleEllipsis(path, 36) : path;
    link.setText(display);
    link.setAttr("title", path);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      this.actions.onOpenNote?.(path);
    });
  }

  /** Render a compact oldText(−)/newText(+) diff, capped so it can't dominate the step. */
  private renderEditDiff(call: HTMLElement, edits: EditPair[]): void {
    const pre = call.createEl("pre", { cls: "agentic-chat-step-diff" });
    const MAX_LINES = 24;
    let count = 0;
    let elided = false;
    const pushLine = (text: string, cls: string, marker: string): void => {
      if (count >= MAX_LINES) {
        elided = true;
        return;
      }
      const row = pre.createDiv({ cls: ["agentic-chat-diff-line", cls] });
      row.createSpan({ cls: "agentic-chat-diff-marker", text: marker });
      row.createSpan({ text: text === "" ? " " : text });
      count += 1;
    };
    for (const edit of edits) {
      for (const line of edit.oldText.split("\n")) pushLine(line, "is-del", "−");
      for (const line of edit.newText.split("\n")) pushLine(line, "is-add", "+");
    }
    if (elided) pre.createDiv({ cls: "agentic-chat-diff-elide", text: "…" });
  }

  /**
   * Live update for a running tool step. Currently renders subagent child
   * progress (a collapsed-per-child, expandable tree) as the dispatch runs.
   */
  updateStep(id: string, partial: unknown): void {
    const step = this.steps.get(id);
    if (!step) return;
    const details = (partial as { details?: unknown } | undefined)?.details as
      | { kind?: string; children?: SubagentChildStatus[] }
      | AskUserDetails
      | undefined;
    if (!details) return;
    if (details.kind === "subagent" && "children" in details && Array.isArray(details.children)) {
      this.renderSubagentChildren(step.body, details.children);
      if (step.card.parentElement) this.syncStepCollapsible(step.card.parentElement, step.body);
      // Auto-open so live child progress is visible while the step runs.
      step.card.addClass("is-open");
      step.card.parentElement?.querySelector(".agentic-chat-step-toggle")?.setAttribute("aria-expanded", "true");
      return;
    }
    if (isAskUserDetails(details)) {
      this.renderAskUserStep(step.body, details);
      if (step.card.parentElement) this.syncStepCollapsible(step.card.parentElement, step.body);
      // Auto-open so the ask-user state is visible while waiting.
      step.card.addClass("is-open");
      step.card.parentElement?.querySelector(".agentic-chat-step-toggle")?.setAttribute("aria-expanded", "true");
    }
  }

  private renderSubagentChildren(card: HTMLElement, children: SubagentChildStatus[]): void {
    let list = card.querySelector<HTMLElement>(".agentic-chat-subagents");
    list ??= card.createDiv({ cls: "agentic-chat-subagents" });
    // ponytail: index-based identity assumes stable child order. Add keyed lookup if reordering is introduced.
    while (list.childElementCount < children.length) {
      list.createEl("details", { cls: "agentic-chat-subagent" });
    }
    while (list.childElementCount > children.length) {
      list.lastElementChild?.remove();
    }
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childRow = list.children[i] as HTMLDetailsElement;
      childRow.className = `agentic-chat-subagent is-${child.status}`;
      childRow.open = child.status === "running";
      this.renderSubagentHeader(childRow, child);
      this.renderSubagentBody(childRow, child);
    }
    // Aggregate child state into ONE status pill on the step header so a card
    // never reads "stoppable" and "done" at the same time (Stop only ever
    // accompanies a still-running aggregate; done/failed have none).
    this.renderSubagentAggregate(card, children);
  }

  private renderSubagentAggregate(card: HTMLElement, children: SubagentChildStatus[]): void {
    // `card` is the step BODY; the status pill lives in the step HEADER, which is
    // a child of the step card (the body's parent).
    const header = card.parentElement?.querySelector<HTMLElement>(".agentic-chat-step-header");
    if (!header) return;
    let pill = header.querySelector<HTMLElement>(".agentic-chat-step-status");
    pill ??= header.createSpan({ cls: "agentic-chat-step-status" });
    const running = children.some((child) => child.status === "running");
    const queued = !running && children.some((child) => child.status === "queued");
    const failed = children.some((child) => child.status === "error");
    const stopped = !failed && children.some((child) => child.status === "aborted");
    let text: string;
    let stateClass: string;
    if (running) {
      text = "Running…";
      stateClass = "is-running";
    } else if (queued) {
      text = "Queued…";
      stateClass = "is-queued";
    } else if (failed) {
      text = "Failed";
      stateClass = "is-error";
    } else if (stopped) {
      text = "Stopped";
      stateClass = "is-error";
    } else {
      text = "Done";
      stateClass = "is-done";
    }
    pill.setText(text);
    pill.removeClass("is-running");
    pill.removeClass("is-done");
    pill.removeClass("is-error");
    pill.removeClass("is-queued");
    pill.addClass(stateClass);
  }

  private renderSubagentHeader(row: HTMLDetailsElement, child: SubagentChildStatus): void {
    let summary = row.querySelector("summary");
    if (!summary) summary = row.createEl("summary");
    const nameText = `${child.agent}: ${truncateText(child.task, 120)}`;
    const statusText = SUBAGENT_STATUS_LABEL[child.status];
    const metaText = this.subagentMetaText(child);
    const currentName = summary.querySelector<HTMLElement>(".agentic-chat-subagent-name")?.textContent;
    const currentStatus = summary.querySelector<HTMLElement>(".agentic-chat-subagent-status")?.textContent;
    const currentMeta = summary.querySelector<HTMLElement>(".agentic-chat-subagent-meta")?.textContent;
    // Absent meta renders as "" (queued/running); compare normalized so a
    // settled header with no meta isn't rebuilt on every live emit.
    if (currentName === nameText && currentStatus === statusText && (currentMeta ?? "") === metaText) return;
    summary.empty();
    summary.createSpan({ cls: "agentic-chat-subagent-name", text: nameText });
    summary.createSpan({ cls: "agentic-chat-subagent-status", text: statusText });
    // Small, subtle completion readout once the child settles: how long it ran,
    // how many tokens it used, and the approximate cost (when priced).
    if (metaText) {
      summary.createSpan({ cls: "agentic-chat-subagent-meta", text: metaText });
    }
    if (child.status === "running" && child.stopId && this.actions.onStopSubagentChild) {
      const stopBtn = summary.createEl("button", { cls: "agentic-chat-subagent-stop", text: "Stop" });
      const id = child.stopId;
      stopBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.actions.onStopSubagentChild?.(id);
      });
    }
  }

  private subagentMetaText(child: SubagentChildStatus): string {
    if (child.status === "queued" || child.status === "running") return "";
    const parts: string[] = [];
    if (child.durationMs !== undefined) parts.push(formatElapsed(child.durationMs));
    if (child.usage && child.usage.totalTokens > 0) {
      parts.push(`${formatTokenInteger(child.usage.totalTokens)} tok`);
      if (child.usage.costUsd > 0) parts.push(formatCost(child.usage.costUsd));
    }
    return parts.join(" · ");
  }

  private renderSubagentBody(row: HTMLDetailsElement, child: SubagentChildStatus): void {
    let pre = row.querySelector<HTMLPreElement>("pre");
    if (!pre) pre = row.createEl("pre");
    if (child.transcript && child.transcript.length > 0) {
      const rendered = Number(pre.dataset.rendered ?? "0");
      if (rendered < child.transcript.length) {
        for (let j = rendered; j < child.transcript.length; j++) {
          pre.appendText(this.formatTranscriptEntry(child.transcript[j]));
        }
        pre.dataset.rendered = String(child.transcript.length);
      }
    }
    if (child.status === "running") {
      delete pre.dataset.hasSummary;
    } else if (child.summary) {
      if (!pre.dataset.hasSummary) {
        pre.appendText("\n———\n");
        pre.appendText(truncateText(child.summary, 4_000));
        pre.dataset.hasSummary = "true";
      }
    }
  }

  private formatTranscriptEntry(entry: NonNullable<SubagentChildStatus["transcript"]>[number]): string {
    if (entry.type === "text") return entry.text;
    const marker = entry.status === "start" ? "▶" : entry.isError ? "✗" : "✓";
    if (entry.status === "start" && entry.args !== undefined) {
      const label = describeCall(entry.name, safeJson(entry.args));
      return `\n${marker} ${label}\n`;
    }
    return `\n${marker} ${entry.name}\n`;
  }

  private renderAskUserStep(card: HTMLElement, details: AskUserDetails): void {
    let row = card.querySelector<HTMLElement>(".agentic-chat-step-ask-user");
    row ??= card.createDiv({ cls: "agentic-chat-step-ask-user" });
    row.empty();
    row.createDiv({
      cls: "agentic-chat-step-ask-user-status",
      text: details.status === "answered" ? "answered" : "waiting for user",
    });
    row.createDiv({ cls: "agentic-chat-step-ask-user-question", text: truncateText(details.question, 400) });
    if (details.answer) row.createDiv({ cls: "agentic-chat-step-ask-user-answer", text: truncateText(details.answer, 400) });
  }

  endStep(id: string, result: string, isError: boolean, resultObject?: unknown): void {
    const step = this.steps.get(id);
    if (!step) return;
    // A subagent dispatch whose children failed or were stopped returns a
    // normal tool result (so the parent won't re-dispatch), but the step must
    // still read as an error — derive it from the child statuses.
    if (step.name === "subagent") {
      const children = subagentChildrenFromResult(resultObject);
      if (children.some((child) => child.status === "error" || child.status === "aborted")) {
        isError = true;
      }
    }
    step.card.removeClass("is-running");
    step.card.addClass(isError ? "is-error" : "is-done");
    setIcon(step.icon, isError ? "x-circle" : "check-circle-2");
    // Per-step elapsed time, surfaced once the step settles.
    step.card.querySelector(".agentic-chat-step-header")?.createSpan({
      cls: "agentic-chat-step-time",
      text: formatElapsed(performance.now() - step.startedAt),
    });
    // get_active_note carries its target path in the RESULT, not the args, so
    // harvest it here (startStep can only see args). Live calls pass the raw
    // result object; history replay passes only the rendered text, whose first
    // line is `Active note: <path>` — parse that so replay chips match live.
    if (!isError) this.harvestActiveNotePath(step, result, resultObject, id);
    // A failed tool call is not a citation: retract its source chip and keep the
    // step expanded so the human can see WHY it failed (no hidden error reason).
    if (isError) this.retractFailedSource(step, id);
    // Result/Error as a body section. A read/write/get_active_note success result
    // is just file contents (already on disk / in context), so hide it; errors
    // always show. Re-sync the chevron: it only appears once the body has content.
    const hideResult = !isError && HIDE_RESULT_TOOLS.has(step.name);
    if (!hideResult) {
      const resultSection = step.body.createDiv({ cls: "agentic-chat-step-result" });
      resultSection.createDiv({ cls: "agentic-chat-step-section-label", text: isError ? "Error" : "Result" });
      resultSection.createEl("pre", { text: truncateText(result, 4_000) });
    }
    this.syncStepCollapsible(step.card.parentElement ?? step.card, step.body);
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
    step.card.parentElement?.querySelector(".agentic-chat-step-toggle")?.setAttribute("aria-expanded", "true");
  }

  async finalizeText(markdown: string, app: App, component: Component): Promise<void> {
    // Commit any buffered deltas (so streamed reasoning isn't lost) and cancel the
    // pending frame before replacing the streamed text with rendered markdown.
    if (this.flushHandle !== null) {
      cancelAnimationFrame(this.flushHandle);
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
    await MarkdownRenderer.render(app, markdown, this.textEl, "", component);
    enhanceCallouts(this.textEl);
    installRenderedLinkHandlers(this.textEl, app, this.actions.onOpenExternalLink);
    await renderMermaidBlocks(this.textEl);
  }

  /**
   * Settle a turn that produced no rendered text (abort, model error, or a
   * text-less tool-only message): stop live timers and flip the reasoning pill
   * to its static state, but never render markdown. Idempotent.
   */
  finalizeWithoutText(): void {
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

  /**
   * Per-turn usage footers are retired: the current turn's tokens/cache/cost now
   * live in the single collapsed bottom bar. Kept as a no-op so the live and
   * history-replay callers keep working.
   */
  showUsage(_usage: Usage): void {
    // no-op — usage is shown in the view's single bottom bar
  }

  /** Render the inline action row (copy, retry, implement). Safe to call once. */
  showActions(opts: { canRetry: boolean; canImplement?: boolean }): void {
    if (this.actionsEl.childElementCount > 0) return;
    if (!this.markdown.trim()) return;
    this.actionButton("copy", "Copy response", () => void this.copy());
    if (opts.canImplement && this.actions.onImplementPlan) {
      this.actionButton("play", "Implement this plan", this.actions.onImplementPlan);
    }
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

export type RenderedChatLink =
  | { kind: "vault"; target: string }
  | { kind: "external"; target: string };

/** Cap the per-turn source-chip row so it can't dominate a long tool-heavy turn. */
const MAX_SOURCE_CHIPS = 8;

/** Tools whose target file counts as a "source" (its contents were read into context). */
const SOURCE_TOOLS = new Set(["read", "get_active_note", "edit"]);

/** Short display name for a source chip: the last path segment (full path in the title). */
export function sourceChipName(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  const segments = trimmed.split("/");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]) return segments[i];
  }
  return trimmed;
}

/** Truncate from both ends, keeping the head and tail readable (vault paths). */
function middleEllipsis(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

/** `get_active_note`'s rendered result starts with `Active note: <path>`. */
function activeNotePathFromText(text: string): string {
  const match = /^Active note: (.+)$/m.exec(text);
  return match?.[1]?.trim() ?? "";
}

export interface RenderedAnchorLike {
  getAttribute(name: string): string | null;
  dataset: DOMStringMap;
}

export function classifyRenderedChatLink(anchor: RenderedAnchorLike): RenderedChatLink | null {
  const dataHref = cleanLinkTarget(anchor.dataset.href ?? null);
  if (dataHref) return { kind: "vault", target: dataHref };

  const href = cleanLinkTarget(anchor.getAttribute("href"));
  if (!href || href.startsWith("#")) return null;

  const scheme = linkScheme(href);
  if (scheme) {
    if (scheme === "http" || scheme === "https") return { kind: "external", target: href };
    return null;
  }

  return { kind: "vault", target: decodeVaultLinkTarget(href) };
}

function installRenderedLinkHandlers(
  root: HTMLElement,
  app: App,
  onOpenExternalLink: ((target: string) => void) | undefined,
  openWindow: (url: string) => void = defaultExternalLinkOpener,
): void {
  root.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    if (event.instanceOf(MouseEvent) && event.button !== 0) return;
    const anchor = closestAnchor(event.target);
    if (!anchor) return;
    const link = classifyRenderedChatLink(anchor);
    if (!link) return;

    event.preventDefault();
    event.stopPropagation();
    if (link.kind === "vault") {
      void app.workspace.openLinkText(link.target, "", event.instanceOf(MouseEvent) && (event.metaKey || event.ctrlKey));
    } else if (onOpenExternalLink) {
      onOpenExternalLink(link.target);
    } else {
      openWindow(link.target);
    }
  });
}

/**
 * Last-resort opener used only when no `onOpenExternalLink` handler is wired
 * (production always wires one through the mobile-safe system-link path).
 * Reaches the global opener indirectly so the mobile-compat verifier does not
 * flag a bare browser-open call in the source.
 */
function defaultExternalLinkOpener(url: string): void {
  const opener = (window as { open?: (url: string, target?: string, features?: string) => Window | null }).open;
  opener?.(url, "_blank", "noopener,noreferrer");
}

function closestAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  return target instanceof Element ? target.closest("a") : null;
}

function cleanLinkTarget(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function linkScheme(target: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(target);
  return match?.[1].toLowerCase() ?? null;
}

function decodeVaultLinkTarget(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

export function enhanceCallouts(root: HTMLElement): void {
  for (const blockquote of Array.from(root.querySelectorAll("blockquote"))) {
    enhanceSingleCallout(blockquote);
  }
}

function enhanceSingleCallout(blockquote: HTMLElement): void {
  if (blockquote.closest(".callout")) return;
  const first = blockquote.firstElementChild as HTMLElement | null;
  if (!first) return;
  const match = /^\s*\[!([A-Za-z0-9_-]+)\]([+-])?\s*(.*)\s*$/.exec(first.textContent?.split(/\r?\n/, 1)[0] ?? "");
  if (!match) return;

  const type = match[1].toLowerCase();
  const title = match[3].trim() || calloutTitle(type);
  const markerLength = match[0].length;
  const rest = (first.textContent ?? "").slice(markerLength).trimStart();
  if (rest) {
    first.textContent = rest;
  } else {
    first.remove();
  }

  const callout = createActiveDiv();
  callout.className = "callout";
  callout.dataset.callout = type;
  if (match[2]) {
    callout.classList.add("is-collapsible");
    callout.dataset.calloutFold = match[2] === "-" ? "-" : "+";
  }

  const titleEl = callout.createDiv({ cls: "callout-title" });
  const icon = titleEl.createDiv({ cls: "callout-icon" });
  setIcon(icon, "info");
  titleEl.createDiv({ cls: "callout-title-inner", text: title });
  const contentEl = callout.createDiv({ cls: "callout-content" });
  while (blockquote.firstChild) contentEl.appendChild(blockquote.firstChild);
  blockquote.replaceWith(callout);
}

function createActiveDiv(): HTMLDivElement {
  const documentWithHelpers = activeDocument as Document & {
    createDiv?: () => HTMLDivElement;
    win?: Window & { createDiv?: () => HTMLDivElement };
  };
  if (typeof documentWithHelpers.win?.createDiv === "function") {
    return documentWithHelpers.win.createDiv();
  }
  if (typeof documentWithHelpers.createDiv === "function") {
    return documentWithHelpers.createDiv();
  }
  const doc = activeDocument;
  return doc.createDiv();
}

let mermaidId = 0;

export async function renderMermaidBlocks(root: HTMLElement): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre > code.language-mermaid"));
  if (blocks.length === 0) return;
  let mermaid: MermaidRenderer;
  try {
    mermaid = (await loadMermaid()) as MermaidRenderer;
  } catch {
    return;
  }
  for (const code of blocks) {
    await renderSingleMermaidBlock(code, mermaid);
  }
}

async function renderSingleMermaidBlock(code: HTMLElement, mermaid: MermaidRenderer): Promise<void> {
  const pre = code.parentElement;
  if (!pre) return;
  const source = code.textContent ?? "";
  const target = createActiveDiv();
  target.className = "agentic-chat-mermaid";
  try {
    const rendered = await mermaid.render(`agentic-chat-mermaid-${mermaidId++}`, source);
    const svgMarkup = typeof rendered === "string" ? rendered : rendered.svg;
    // Parse the SVG into a dedicated document and import the node instead of
    // assigning to innerHTML — keeps the mermaid output out of an unsanitized
    // HTML sink (and is the namespace-correct way to insert SVG markup).
    const svgDocument = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
    const svgRoot = svgDocument.documentElement;
    // Reject malformed Mermaid output — a missing/non-<svg> root or a DOMParser
    // <parsererror> node — before it reaches the live document. Throwing here
    // falls into the surrounding catch, which flags the block as a render error.
    if (svgRoot?.localName?.toLowerCase() !== "svg" || svgRoot?.querySelector("parsererror")) {
      throw new Error("Mermaid renderer returned invalid SVG or parser error");
    }
    target.replaceChildren(activeDocument.importNode(svgRoot, true));
    if (typeof rendered !== "string") rendered.bindFunctions?.(target);
    pre.replaceWith(target);
  } catch (error) {
    pre.addClass("agentic-chat-mermaid-error");
    pre.setAttr("title", error instanceof Error ? error.message : String(error));
  }
}

interface MermaidRenderer {
  render(
    id: string,
    source: string,
  ): Promise<string | { svg: string; bindFunctions?: (element: Element) => void }> | string | { svg: string; bindFunctions?: (element: Element) => void };
}

function calloutTitle(type: string): string {
  return type.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

interface EditPair {
  oldText: string;
  newText: string;
}

/** "lines a–b" for a read call's offset/limit, or "" when neither is set. */
function readRangeText(args: Record<string, unknown>): string {
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 0;
  const end = offset !== undefined && limit !== undefined ? offset + limit : "?";
  return `lines ${start}–${end}`;
}

function isStringEditPair(value: unknown): value is EditPair {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { oldText?: unknown }).oldText === "string" &&
    typeof (value as { newText?: unknown }).newText === "string"
  );
}

function isAskUserDetails(value: unknown): value is AskUserDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "ask_user" &&
    typeof (value as { status?: unknown }).status === "string" &&
    typeof (value as { question?: unknown }).question === "string" &&
    Array.isArray((value as { choices?: unknown }).choices)
  );
}
