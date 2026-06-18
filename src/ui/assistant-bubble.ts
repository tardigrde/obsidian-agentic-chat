import { type App, type Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type { Usage } from "@earendil-works/pi-ai";
import type { SubagentChildStatus } from "../tools/subagent-tool";
import { describeCall, formatElapsed, formatUsage, truncateText } from "./format";

const SUBAGENT_STATUS_LABEL: Record<SubagentChildStatus["status"], string> = {
  running: "running…",
  done: "done",
  error: "failed",
};

export interface BubbleActions {
  /** Re-run the conversation's last user turn. */
  onRetry?: () => void;
}

/** Owns the DOM of a single assistant turn: reasoning, tool steps, text, actions, footer. */
export class AssistantBubble {
  private readonly el: HTMLElement;
  private readonly stepsEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly footerEl: HTMLElement;
  private reasoningBody: HTMLElement | null = null;
  private markdown = "";
  private readonly steps = new Map<string, { card: HTMLElement; icon: HTMLElement; startedAt: number }>();
  // Streaming deltas are buffered and flushed once per animation frame, so a fast
  // token stream causes one DOM mutation/reflow per frame instead of one per token.
  private pendingText = "";
  private pendingReasoning = "";
  private flushHandle: number | null = null;

  constructor(
    parent: HTMLElement,
    private readonly actions: BubbleActions = {},
  ) {
    this.el = parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-assistant"] });
    this.stepsEl = this.el.createDiv({ cls: "agentic-chat-steps" });
    this.textEl = this.el.createDiv({ cls: ["agentic-chat-text", "is-streaming"] });
    this.actionsEl = this.el.createDiv({ cls: "agentic-chat-actions" });
    this.footerEl = this.el.createDiv({ cls: "agentic-chat-footer" });
  }

  appendText(delta: string): void {
    // Ignore late deltas after the bubble has been finalized to rendered
    // markdown, so a stray event can't append raw text over the final output.
    if (this.markdown) return;
    this.pendingText += delta;
    this.scheduleFlush();
  }

  appendReasoning(delta: string): void {
    if (this.markdown) return;
    // Create the reasoning container eagerly so the structure is in place; the
    // text itself is buffered and flushed with the rest on the next frame.
    if (!this.reasoningBody) {
      const details = this.el.createEl("details", { cls: "agentic-chat-reasoning" });
      details.createEl("summary", { text: "Reasoning" });
      this.reasoningBody = details.createDiv({ cls: "agentic-chat-reasoning-body" });
      this.el.insertBefore(details, this.stepsEl);
    }
    this.pendingReasoning += delta;
    this.scheduleFlush();
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
    if (this.pendingText) {
      this.textEl.appendText(this.pendingText);
      this.pendingText = "";
    }
    if (this.pendingReasoning && this.reasoningBody) {
      this.reasoningBody.appendText(this.pendingReasoning);
      this.pendingReasoning = "";
    }
  }

  startStep(id: string, name: string, rawArgs: string): void {
    const card = this.stepsEl.createDiv({ cls: ["agentic-chat-step", "is-running"] });
    const header = card.createDiv({ cls: "agentic-chat-step-header" });
    const icon = header.createSpan({ cls: "agentic-chat-step-icon" });
    setIcon(icon, "loader-2");
    header.createSpan({ cls: "agentic-chat-step-name", text: describeCall(name, rawArgs) });
    if (rawArgs && rawArgs !== "{}") {
      card.createEl("code", { cls: "agentic-chat-step-args", text: truncateText(rawArgs, 200) });
    }
    this.steps.set(id, { card, icon, startedAt: performance.now() });
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
      | undefined;
    if (!details || details.kind !== "subagent" || !Array.isArray(details.children)) return;
    this.renderSubagentChildren(step.card, details.children);
  }

  private renderSubagentChildren(card: HTMLElement, children: SubagentChildStatus[]): void {
    let list = card.querySelector<HTMLElement>(".agentic-chat-subagents");
    if (!list) list = card.createDiv({ cls: "agentic-chat-subagents" });
    list.empty();
    for (const child of children) {
      const row = list.createEl("details", { cls: ["agentic-chat-subagent", `is-${child.status}`] });
      const summary = row.createEl("summary");
      summary.createSpan({ cls: "agentic-chat-subagent-name", text: `${child.agent}: ${child.task}` });
      summary.createSpan({ cls: "agentic-chat-subagent-status", text: SUBAGENT_STATUS_LABEL[child.status] });
      if (child.summary) row.createEl("pre", { text: truncateText(child.summary, 4_000) });
    }
  }

  endStep(id: string, result: string, isError: boolean): void {
    const step = this.steps.get(id);
    if (!step) return;
    step.card.removeClass("is-running");
    step.card.addClass(isError ? "is-error" : "is-done");
    setIcon(step.icon, isError ? "x-circle" : "check-circle-2");
    // Per-step elapsed time, surfaced once the step settles.
    const header = step.card.querySelector<HTMLElement>(".agentic-chat-step-header");
    header?.createSpan({ cls: "agentic-chat-step-time", text: formatElapsed(performance.now() - step.startedAt) });
    const details = step.card.createEl("details", { cls: "agentic-chat-step-result" });
    details.createEl("summary", { text: isError ? "Error" : "Result" });
    details.createEl("pre", { text: truncateText(result, 4_000) });
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
    await MarkdownRenderer.render(app, markdown, this.textEl, "", component);
  }

  showError(message: string): void {
    const banner = this.el.createDiv({ cls: "agentic-chat-error" });
    banner.setText(message);
    this.el.insertBefore(banner, this.actionsEl);
  }

  showUsage(usage: Usage): void {
    this.footerEl.setText(formatUsage(usage));
  }

  /** Render the inline action row (copy, and optionally retry). Safe to call once. */
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
