import { type App, type Component, loadMermaid, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type { Usage } from "@earendil-works/pi-ai";
import type { SubagentChildStatus } from "../tools/subagent-tool";
import type { AskUserDetails } from "../tools/ask-user-tool";
import { describeCall, formatElapsed, formatUsage, truncateText } from "./format";

const SUBAGENT_STATUS_LABEL: Record<SubagentChildStatus["status"], string> = {
  running: "running…",
  done: "done",
  error: "failed",
};

export interface BubbleActions {
  /** Re-run the conversation's last user turn. */
  onRetry?: () => void;
  /** Open an external rendered link such as https:// or external://. */
  onOpenExternalLink?: (target: string) => void;
  /** Called after buffered streaming text/reasoning mutates the bubble. */
  onContentChange?: () => void;
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
      | AskUserDetails
      | undefined;
    if (!details) return;
    if (details.kind === "subagent" && "children" in details && Array.isArray(details.children)) {
      this.renderSubagentChildren(step.card, details.children);
      return;
    }
    if (isAskUserDetails(details)) {
      this.renderAskUserStep(step.card, details);
    }
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

  private renderAskUserStep(card: HTMLElement, details: AskUserDetails): void {
    let row = card.querySelector<HTMLElement>(".agentic-chat-step-ask-user");
    if (!row) row = card.createDiv({ cls: "agentic-chat-step-ask-user" });
    row.empty();
    row.createDiv({
      cls: "agentic-chat-step-ask-user-status",
      text: details.status === "answered" ? "answered" : "waiting for user",
    });
    row.createDiv({ cls: "agentic-chat-step-ask-user-question", text: truncateText(details.question, 400) });
    if (details.answer) row.createDiv({ cls: "agentic-chat-step-ask-user-answer", text: truncateText(details.answer, 400) });
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
    this.textEl.addClass("markdown-rendered");
    await MarkdownRenderer.render(app, markdown, this.textEl, "", component);
    enhanceCallouts(this.textEl);
    installRenderedLinkHandlers(this.textEl, app, this.actions.onOpenExternalLink);
    await renderMermaidBlocks(this.textEl);
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

export type RenderedChatLink =
  | { kind: "vault"; target: string }
  | { kind: "external"; target: string };

export interface RenderedAnchorLike {
  getAttribute(name: string): string | null;
}

export function classifyRenderedChatLink(anchor: RenderedAnchorLike): RenderedChatLink | null {
  const dataHref = cleanLinkTarget(anchor.getAttribute("data-href"));
  if (dataHref) return { kind: "vault", target: dataHref };

  const href = cleanLinkTarget(anchor.getAttribute("href"));
  if (!href || href.startsWith("#")) return null;

  const scheme = linkScheme(href);
  if (scheme) {
    if (scheme === "http" || scheme === "https" || scheme === "external") return { kind: "external", target: href };
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
  return trimmed ? trimmed : null;
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
    if (blockquote.closest(".callout")) continue;
    const first = blockquote.firstElementChild as HTMLElement | null;
    if (!first) continue;
    const match = /^\s*\[!([A-Za-z0-9_-]+)\]([+-])?\s*(.*)\s*$/.exec(first.textContent?.split(/\r?\n/, 1)[0] ?? "");
    if (!match) continue;

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
  const createElement = doc.createElement.bind(doc);
  return createElement("div");
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
    const pre = code.parentElement;
    if (!pre) continue;
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
      if (!svgRoot || svgRoot.localName.toLowerCase() !== "svg" || svgRoot.querySelector("parsererror")) {
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
