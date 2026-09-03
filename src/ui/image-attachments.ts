/**
 * Pure helpers for vision (image) attachments. Kept separate from `chat-view` so
 * they're unit-testable without the Obsidian UI, and reused by the chip rendering
 * and the outgoing-message image encoding.
 */
import { attachmentBasePath } from "./attachment-ref";
import type { ContextAttachment } from "./context-attachments";

/** Vault image extensions an OpenRouter vision model can read. */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** True when an attachment path points at an image file (by extension). */
export function isImagePath(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (!base.includes(".")) return false;
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

/** MIME type for an image file extension (defaults to PNG for unknown). */
export function imageMimeType(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "png":
    default:
      return "image/png";
  }
}

/**
 * Base64-encode binary image data in chunks. The chunk is small (4 KiB) so the
 * `String.fromCharCode(...chunk)` spread can't blow the call stack on engines with
 * a low argument cap (notably iOS JavaScriptCore) when encoding a large image.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x1000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** True when an image src is already renderable (remote, app resource, or inline data). */
export function isExternalImageSrc(src: string): boolean {
  const trimmed = src.trim();
  // Protocol-relative URLs never resolve to vault files.
  if (trimmed.startsWith("//")) return true;
  // Any URI scheme (http:, app:, data:, blob:, but also javascript:/file:/etc.)
  // is outside the vault — only scheme-less paths reach vault lookup.
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed);
}

/** Strip a trailing `#fragment` / `?query` so extension checks see the real path. */
export function stripImageQueryFragment(target: string): string {
  const hash = target.indexOf("#");
  const query = target.indexOf("?");
  let end = target.length;
  if (hash !== -1) end = Math.min(end, hash);
  if (query !== -1) end = Math.min(end, query);
  return target.slice(0, end);
}

/**
 * Parse the inner payload of a `![[...]]` wiki embed into its vault target.
 * `![[image.png|300]]` → `image.png`; `![[note#heading]]` stays a note ref
 * (callers check isImagePath before treating it as an image).
 */
export function parseWikiImageTarget(inner: string): string {
  return inner.split("|")[0].trim();
}

/** Basename of a vault path for use as fallback `<img>` alt text. */
export function imageBasename(path: string): string {
  const clean = stripImageQueryFragment(path.trim());
  const segments = clean.split("/");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]) return segments[i];
  }
  return clean;
}

/**
 * Rewrite vault-local image references in markdown to pre-resolved resource URLs.
 * Wiki embeds (`![[pic.png]]`) become `![](resolved)`; markdown destinations
 * (`![](vault/path/pic.png)`) have their destination swapped for the resolved URL.
 * External (`http`, `app://`, `data:`, …) and non-image targets pass through.
 * Fenced code blocks and inline code spans are left untouched so examples don't
 * turn into images. Pure (no Obsidian API) — `resolve` maps a vault target to a
 * renderable URL, or null when unresolvable.
 */
export function rewriteMarkdownImages(
  markdown: string,
  resolve: (target: string) => string | null,
): string {
  const segments = splitMarkdownByCode(markdown);
  return segments
    .map((segment) => (segment.isCode ? segment.text : rewriteMarkdownImagesInText(segment.text, resolve)))
    .join("");
}

function rewriteMarkdownImagesInText(
  text: string,
  resolve: (target: string) => string | null,
): string {
  const withWiki = text.replace(/!\[\[([^\]\n]+)\]\]/g, (match, inner: string) => {
    const target = parseWikiImageTarget(String(inner ?? ""));
    if (!target) return match;
    if (!isImagePath(stripImageQueryFragment(target))) return match;
    const resolved = safeResolve(resolve, target);
    if (!resolved) return match;
    // Brackets would break the generated alt text — strip them (render-escaped anyway).
    const alt = imageBasename(target).replace(/[[\]]/g, "");
    return `![${alt}](${resolved})`;
  });
  return withWiki.replace(
    /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g,
    (match, alt: string, rawDest: string, title: string | undefined) => {
      let dest = String(rawDest ?? "").trim();
      if (dest.startsWith("<") && dest.endsWith(">")) dest = dest.slice(1, -1).trim();
      if (!dest || isExternalImageSrc(dest)) return match;
      if (!isImagePath(stripImageQueryFragment(dest))) return match;
      const resolved = safeResolve(resolve, dest);
      if (!resolved) return match;
      return `![${String(alt ?? "")}](${resolved}${title ?? ""})`;
    },
  );
}

function safeResolve(resolve: (target: string) => string | null, target: string): string | null {
  try {
    const resolved = resolve(target);
    return resolved && resolved.trim() ? resolved : null;
  } catch {
    return null;
  }
}

interface MarkdownSegment {
  text: string;
  isCode: boolean;
}

/**
 * Split markdown into code / non-code spans so image rewriting skips fenced
 * blocks (``` / ~~~) and inline `code`. Fences win over inline spans: an
 * inline backtick inside a fence stays fenced.
 */
function splitMarkdownByCode(markdown: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const lines = markdown.split("\n");
  let prose: string[] = [];
  let code: string[] = [];
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  // Indented code blocks (4+ spaces/tab) start after a blank line — or the
  // document start — and run through blank lines until non-indented content.
  // They can't interrupt a paragraph, so mid-paragraph indented lines stay prose.
  let afterBlank = true;
  let inIndentedCode = false;

  const flushProse = (): void => {
    if (prose.length > 0) {
      segments.push({ text: prose.join("\n"), isCode: false });
      prose = [];
    }
  };
  const flushCode = (): void => {
    if (code.length > 0) {
      segments.push({ text: code.join("\n"), isCode: true });
      code = [];
    }
  };

  for (const line of lines) {
    if (fenceChar !== null) {
      code.push(line);
      if (isFenceClose(line, fenceChar, fenceLen)) {
        flushCode();
        fenceChar = null;
        fenceLen = 0;
      }
      afterBlank = false;
      inIndentedCode = false;
      continue;
    }
    if (line.trim() === "") {
      // Blank lines belong to the open run (a trailing blank is still code);
      // either way they enable the next indented block.
      (inIndentedCode ? code : prose).push(line);
      afterBlank = true;
      continue;
    }
    const opening = fenceMarkerLength(line);
    if (opening) {
      flushProse();
      flushCode();
      fenceChar = opening.char;
      fenceLen = opening.len;
      code.push(line);
      afterBlank = false;
      inIndentedCode = false;
      continue;
    }
    if (isIndentedCodeLine(line) && (afterBlank || inIndentedCode)) {
      flushProse();
      code.push(line);
      inIndentedCode = true;
      afterBlank = false;
      continue;
    }
    flushCode();
    prose.push(line);
    inIndentedCode = false;
    afterBlank = false;
  }
  // An unclosed fence swallows the rest of the document — same as the renderer.
  flushCode();
  flushProse();
  // Re-attach the "\n" separators lost to split, then split prose on inline code.
  const withBreaks: MarkdownSegment[] = [];
  for (let i = 0; i < segments.length; i++) {
    withBreaks.push(segments[i]);
    if (i < segments.length - 1) withBreaks.push({ text: "\n", isCode: false });
  }
  const expanded: MarkdownSegment[] = [];
  for (const segment of withBreaks) {
    if (segment.isCode || segment.text === "\n") {
      expanded.push(segment);
      continue;
    }
    expanded.push(...splitInlineCode(segment.text));
  }
  return expanded;
}

/**
 * Opening fence run on a line (` ```js `, ` ~~~ `, `> ``` `), or null.
 * Up to 3 leading spaces (4+ is an indented code block, not a fence) with an
 * optional blockquote chain — both match the renderer's fence recognition.
 */
function fenceMarkerLength(line: string): { char: "`" | "~"; len: number } | null {
  const match = /^(?: {0,3}>\s?)* {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  const run = match[1];
  return { char: run[0] === "`" ? "`" : "~", len: run.length };
}

/**
 * Closing fence: same character, run at least as long as the opener, and
 * nothing but whitespace after it (an info string keeps the fence open).
 */
function isFenceClose(line: string, char: "`" | "~", minLen: number): boolean {
  const match = /^(?: {0,3}>\s?)* {0,3}(`+|~+)/.exec(line);
  if (!match) return false;
  const run = match[1];
  if (run[0] !== char || run.length < minLen) return false;
  return line.slice(match[0].length).trim() === "";
}

/**
 * Indented code line: 4+ spaces or a tab (after up to 3 spaces), optionally
 * inside a blockquote chain. Approximation: list-item-relative indentation is
 * not modeled, so a deeply indented list continuation may read as code (a
 * silent feature miss, never corruption).
 */
function isIndentedCodeLine(line: string): boolean {
  const stripped = line.replace(/^(?: {0,3}>\s?)*/, "");
  return /^(?: {4}| {0,3}\t)/.test(stripped);
}

/**
 * Split a non-fenced span on inline code spans of any backtick-run length.
 * An unclosed run is literal text (matching the renderer), but a later run on
 * the same span can still open a code span.
 */
function splitInlineCode(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const pattern = /(`+)/g;
  let last = 0;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = pattern.exec(text)) !== null) {
    const run = openMatch[1];
    const closer = findInlineCodeClose(text, openMatch.index + run.length, run);
    if (closer === -1) continue;
    if (openMatch.index > last) segments.push({ text: text.slice(last, openMatch.index), isCode: false });
    segments.push({ text: text.slice(openMatch.index, closer + run.length), isCode: true });
    last = closer + run.length;
    pattern.lastIndex = last;
  }
  if (last < text.length) segments.push({ text: text.slice(last), isCode: false });
  if (segments.length === 0) segments.push({ text, isCode: false });
  return segments;
}

/** Offset of the closing run equal in length to `run`, isolated from longer runs. */
function findInlineCodeClose(text: string, from: number, run: string): number {
  let idx = from;
  while (true) {
    idx = text.indexOf(run, idx);
    if (idx === -1) return -1;
    if (text[idx - 1] !== "`" && text[idx + run.length] !== "`") return idx;
    idx += 1;
  }
}

/** A renderable user-bubble thumbnail: live vault images carry `path` (click opens them). */
export interface UserImageThumb {
  src: string;
  alt: string;
  path?: string;
}

/** History image blocks only ever carry raster data the vision models accept. */
const IMAGE_MIME_PATTERN = /^image\/(png|jpe?g|gif|webp)$/i;

/** Clamp a persisted mime type to a renderable image type (default PNG). */
export function sanitizeImageMimeType(mimeType: unknown): string {
  return typeof mimeType === "string" && IMAGE_MIME_PATTERN.test(mimeType.trim()) ? mimeType.trim() : "image/png";
}

/**
 * Thumbnail sources for a user bubble, pure and unit-testable. Live vault-path
 * attachments resolve via `resolvePath` (resource URLs; a miss/throw drops the
 * image); replayed vision blocks render from persisted base64 data. Capped so a
 * turn can't flood the pane. The DOM wiring in `chat-view` stays thin.
 */
export function collectUserImageThumbs(
  attachments: readonly ContextAttachment[],
  historyImages: ReadonlyArray<{ data: unknown; mimeType: unknown }> | undefined,
  resolvePath: (path: string) => string | null,
  max = 8,
): UserImageThumb[] {
  const thumbs: UserImageThumb[] = [];
  for (const entry of attachments) {
    if (thumbs.length >= max) break;
    if (typeof entry !== "string") continue;
    const base = stripImageQueryFragment(attachmentBasePath(entry));
    if (!base || !isImagePath(base)) continue;
    let src: string | null;
    try {
      src = resolvePath(base);
    } catch {
      src = null;
    }
    if (!src) continue;
    thumbs.push({ src, alt: base, path: base });
  }
  for (const image of historyImages ?? []) {
    if (thumbs.length >= max) break;
    const data = typeof image?.data === "string" ? image.data.trim() : "";
    if (!data) continue;
    thumbs.push({ src: `data:${sanitizeImageMimeType(image?.mimeType)};base64,${data}`, alt: "Attached image" });
  }
  return thumbs;
}
