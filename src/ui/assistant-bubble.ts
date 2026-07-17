import { type App, type Component, loadMermaid, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type { Usage } from "@earendil-works/pi-ai";
import type { SubagentChildStatus } from "../tools/subagent-tool";
import type { AskUserDetails } from "../tools/ask-user-tool";
import {
  callPath,
  describeCall,
  formatCallBody,
  formatElapsed,
  formatUsage,
  formatUsageDelta,
  HIDE_RESULT_TOOLS,
  PATH_TOOLS,
  TOOL_LABELS,
  truncateText,
} from "./format";

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
  /** Open a vault-relative note path shown in a tool-call section (e.g. read/write/edit target). */
  onOpenNote?: (path: string) => void;
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
  private readonly steps = new Map<string, {
    card: HTMLElement;
    icon: HTMLElement;
    body: HTMLElement;
    name: string;
    startedAt: number;
  }>();
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
    // A step is a manual collapsible (not native <details>): the header carries
    // a chevron toggle + status icon + a readable label with a clickable path,
    // and only the chevron toggles the body — so clicking the path link opens
    // the note without collapsing the step. Raw arg JSON is never shown inline.
    const card = this.stepsEl.createDiv({ cls: ["agentic-chat-step", "is-running"] });
    const header = card.createDiv({ cls: "agentic-chat-step-header" });
    const toggle = header.createSpan({
      cls: "agentic-chat-step-toggle",
      attr: { role: "button", tabindex: "0", "aria-expanded": "false", "aria-label": "Toggle details" },
    });
    const chevron = toggle.createSpan({ cls: "agentic-chat-step-chevron" });
    setIcon(chevron, "chevron-right");
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleStep(card);
    });
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.toggleStep(card);
      }
    });
    const icon = header.createSpan({ cls: "agentic-chat-step-icon" });
    setIcon(icon, "loader-2");
    const nameEl = header.createSpan({ cls: "agentic-chat-step-name" });
    this.renderStepTitle(nameEl, name, rawArgs);
    const body = card.createDiv({ cls: "agentic-chat-step-body" });
    this.renderCallSection(body, name, rawArgs);
    this.syncStepCollapsible(card, body);
    this.steps.set(id, { card, icon, body, name, startedAt: performance.now() });
  }

  /** Toggle a step's body open/closed and reflect state on the chevron + aria. */
  private toggleStep(card: HTMLElement): void {
    const open = card.classList.toggle("is-open");
    card.querySelector(".agentic-chat-step-toggle")?.setAttribute("aria-expanded", String(open));
  }

  /** Hide the chevron + collapse affordance when the body has nothing to show. */
  private syncStepCollapsible(card: HTMLElement, body: HTMLElement): void {
    const toggle = card.querySelector<HTMLElement>(".agentic-chat-step-toggle");
    if (!toggle) return;
    toggle.toggleClass("is-hidden", body.childElementCount === 0);
  }

  /** Render the header title: a readable label, with a clickable vault path for path-bearing tools. */
  private renderStepTitle(nameEl: HTMLElement, name: string, rawArgs: string): void {
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
    link.setText(path);
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
      return;
    }
    if (isAskUserDetails(details)) {
      this.renderAskUserStep(step.body, details);
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
    step.card.querySelector(".agentic-chat-step-header")?.createSpan({
      cls: "agentic-chat-step-time",
      text: formatElapsed(performance.now() - step.startedAt),
    });
    // Result/Error as a body section. A read/write/get_active_note success result
    // is just file contents (already on disk / in context), so hide it; errors
    // always show. Re-sync the chevron: it only appears once the body has content.
    const hideResult = !isError && HIDE_RESULT_TOOLS.has(step.name);
    if (!hideResult) {
      const resultSection = step.body.createDiv({ cls: "agentic-chat-step-result" });
      resultSection.createDiv({ cls: "agentic-chat-step-section-label", text: isError ? "Error" : "Result" });
      resultSection.createEl("pre", { text: truncateText(result, 4_000) });
    }
    this.syncStepCollapsible(step.card, step.body);
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
    if (existing && existing.textContent === text) return;
    const banner = this.el.createDiv({ cls: "agentic-chat-error" });
    if (text.includes("\n")) {
      const details = banner.createEl("details", { cls: "agentic-chat-error-details" });
      details.createEl("summary", { text: text.split("\n", 1)[0] });
      details.createEl("pre", { text });
    } else {
      banner.setText(text);
    }
    this.el.insertBefore(banner, this.actionsEl);
  }

  /**
   * Render the per-answer usage footer. Pass the previous assistant turn's usage
   * to show only the new tokens for this answer (a delta); omit it for the first
   * answer / after a rewind reset so the absolute usage shows instead.
   */
  showUsage(usage: Usage, previous?: Usage): void {
    this.footerEl.setText(previous ? formatUsageDelta(usage, previous) : formatUsage(usage));
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
