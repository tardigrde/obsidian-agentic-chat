import { type App, loadMermaid, Notice, setIcon, TFile } from "obsidian";
import { openSystemUrl } from "../platform/system-browser";
import type { AskUserDetails } from "../tools/ask-user-tool";
import { errorMessage } from "../utils/errors";
import {
  imageBasename,
  isExternalImageSrc,
  isImagePath,
  rewriteMarkdownImages,
  stripImageQueryFragment,
} from "./image-attachments";

export type RenderedChatLink =
  | { kind: "vault"; target: string }
  | { kind: "external"; target: string };

/** Cap the per-turn source-chip row so it can't dominate a long tool-heavy turn. */
export const MAX_SOURCE_CHIPS = 8;

/** Tools whose target file counts as a "source" (its contents were read into context). */
export const SOURCE_TOOLS = new Set(["read", "get_active_note", "edit"]);

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
export function middleEllipsis(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

/** `get_active_note`'s rendered result starts with `Active note: <path>`. */
export function activeNotePathFromText(text: string): string {
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

export function installRenderedLinkHandlers(
  root: HTMLElement,
  app: App,
  onOpenExternalLink: ((target: string) => void) | undefined,
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
      openSystemUrl(link.target).catch((error: unknown) => new Notice(`Could not open link: ${errorMessage(error)}`));
    }
  });
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

/**
 * Vault path Obsidian uses to resolve relative links in chat markdown. The chat
 * pane is not a file, so the active note stands in — any vault path lets
 * `getFirstLinkpathDest` find a `![[pic.png]]` embed by name, and a missing
 * note degrades to the old "" behavior.
 */
export function assistantImageSourcePath(app: App): string {
  try {
    const path = app.workspace?.getActiveFile?.()?.path;
    return typeof path === "string" && path ? path : "";
  } catch {
    return "";
  }
}

/** Resolve a vault-local image target to a renderable resource URL, or null. */
export function resolveVaultImageResource(app: App, target: string, sourcePath: string): string | null {
  const trimmed = target.trim();
  if (!trimmed || isExternalImageSrc(trimmed)) return null;
  let decoded = trimmed;
  try {
    decoded = decodeURI(trimmed);
  } catch {
    // Keep the raw target when it isn't valid percent-encoding.
  }
  const linkpath = stripImageQueryFragment(decoded).trim().replace(/^\/+/, "");
  if (!linkpath) return null;
  try {
    const viaLinks = app.metadataCache?.getFirstLinkpathDest?.(linkpath, sourcePath) as TFile | null | undefined;
    const file = viaLinks ?? app.vault?.getFileByPath?.(linkpath) ?? null;
    if (!file || !(file instanceof TFile)) return null;
    if (!isImagePath(file.path)) return null;
    return app.vault.getResourcePath(file);
  } catch {
    return null;
  }
}

/** Rewrite vault-local image references in assistant markdown to resource URLs. */
export function rewriteAssistantMarkdownImages(app: App, markdown: string, sourcePath: string): string {
  return rewriteMarkdownImages(markdown, (target) => resolveVaultImageResource(app, target, sourcePath));
}

/**
 * Post-render fixup for assistant images: point vault-path `<img>` srcs at
 * resource URLs and materialize unresolved internal image embeds the renderer
 * left behind (e.g. a `![[pic.png]]` it couldn't resolve with the sourcePath).
 */
export function fixupRenderedAssistantImages(root: HTMLElement, app: App, sourcePath: string): void {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    // Vault images already rewritten to resource URLs (the main path).
    if (src?.startsWith("app://")) {
      img.addClass("agentic-chat-image");
      img.setAttribute("loading", "lazy");
      continue;
    }
    if (!src || isExternalImageSrc(src)) continue;
    const resolved = resolveVaultImageResource(app, src, sourcePath);
    if (resolved) {
      img.setAttribute("src", resolved);
      img.addClass("agentic-chat-image");
      img.setAttribute("loading", "lazy");
    }
  }
  for (const embed of Array.from(root.querySelectorAll(".internal-embed"))) {
    if (embed.querySelector("img")) continue;
    const src = embed.getAttribute("src") ?? "";
    if (!src || !isImagePath(stripImageQueryFragment(src))) continue;
    const resolved = resolveVaultImageResource(app, src, sourcePath);
    if (!resolved) continue;
    embed.empty();
    embed.removeClass("is-unresolved");
    embed.addClass("image-embed");
    const img = embed.createEl("img", { attr: { src: resolved, alt: imageBasename(src), loading: "lazy" } });
    img.addClass("agentic-chat-image");
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
    pre.setAttr("title", errorMessage(error));
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

export interface EditPair {
  oldText: string;
  newText: string;
}

/**
 * Render a compact oldText(−)/newText(+) diff for an edit step. The step keeps
 * its own line class: the approval modal and Quick Ask use a diff-table style
 * that must not leak into this flex marker layout.
 */
export function renderStepEditDiff(call: HTMLElement, edits: EditPair[], maxLines = 24): void {
  const pre = call.createEl("pre", { cls: "agentic-chat-step-diff" });
  let count = 0;
  let elided = false;
  const pushLine = (text: string, cls: string, marker: string): void => {
    if (count >= maxLines) {
      elided = true;
      return;
    }
    const row = pre.createDiv({ cls: ["agentic-chat-step-diff-line", cls] });
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

/** "lines a–b" for a read call's offset/limit, or "" when neither is set. */
export function readRangeText(args: Record<string, unknown>): string {
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 0;
  const end = offset !== undefined && limit !== undefined ? offset + limit : "?";
  return `lines ${start}–${end}`;
}

export function isStringEditPair(value: unknown): value is EditPair {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { oldText?: unknown }).oldText === "string" &&
    typeof (value as { newText?: unknown }).newText === "string"
  );
}

export function isAskUserDetails(value: unknown): value is AskUserDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "ask_user" &&
    typeof (value as { status?: unknown }).status === "string" &&
    typeof (value as { question?: unknown }).question === "string" &&
    Array.isArray((value as { choices?: unknown }).choices)
  );
}
