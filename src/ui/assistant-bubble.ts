import { type App, type Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type { Usage } from "@earendil-works/pi-ai";
import { describeCall, formatUsage, truncateText } from "./format";

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
  private readonly steps = new Map<string, { card: HTMLElement; icon: HTMLElement }>();

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
    this.textEl.appendText(delta);
  }

  appendReasoning(delta: string): void {
    if (!this.reasoningBody) {
      const details = this.el.createEl("details", { cls: "agentic-chat-reasoning" });
      details.createEl("summary", { text: "Reasoning" });
      this.reasoningBody = details.createDiv({ cls: "agentic-chat-reasoning-body" });
      this.el.insertBefore(details, this.stepsEl);
    }
    this.reasoningBody.appendText(delta);
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
    this.steps.set(id, { card, icon });
  }

  endStep(id: string, result: string, isError: boolean): void {
    const step = this.steps.get(id);
    if (!step) return;
    step.card.removeClass("is-running");
    step.card.addClass(isError ? "is-error" : "is-done");
    setIcon(step.icon, isError ? "x-circle" : "check-circle-2");
    const details = step.card.createEl("details", { cls: "agentic-chat-step-result" });
    details.createEl("summary", { text: isError ? "Error" : "Result" });
    details.createEl("pre", { text: truncateText(result, 4_000) });
  }

  async finalizeText(markdown: string, app: App, component: Component): Promise<void> {
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
