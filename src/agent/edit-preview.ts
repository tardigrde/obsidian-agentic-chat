import { applyExactEdits, resolveExactEdits, type ExactEdit, type ResolvedEdit } from "../vault/edit";

/** What a pending mutating tool call would do, ready for the approval modal to render. */
export type EditPreview =
  | { kind: "diff"; path: string; before: string; after: string; isNew: boolean; edits?: ExactEdit[] }
  | { kind: "delete"; path: string; content: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "none" };

export interface ExactEditPreviewWindow {
  before: string;
  after: string;
  hiddenBefore: number;
  hiddenAfter: number;
}

interface RawArgs {
  path?: unknown;
  content?: unknown;
  newPath?: unknown;
  edits?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Narrow unknown tool args to well-formed edits. The model controls these, so a
 * malformed shape (null, a string, missing fields) is filtered out rather than
 * cast through — leaving applyExactEdits to throw on the empty result, which the
 * caller turns into `kind: "none"`.
 */
function asExactEdits(value: unknown): ExactEdit[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (edit): edit is ExactEdit =>
      typeof edit === "object" &&
      edit !== null &&
      typeof (edit as ExactEdit).oldText === "string" &&
      typeof (edit as ExactEdit).newText === "string",
  );
}

/**
 * Describe a mutating tool call as a reviewable change, given the file's current
 * content (`null` when it doesn't exist yet). Pure: the modal supplies the
 * content it read from the vault. Returns `kind: "none"` for non-previewable
 * calls (unknown tool, or an `edit` whose `oldText` no longer matches).
 */
export function buildEditPreview(toolName: string, args: unknown, currentContent: string | null): EditPreview {
  const raw = (args ?? {}) as RawArgs;
  const path = asString(raw.path);
  switch (toolName) {
    case "write":
      return {
        kind: "diff",
        path,
        before: currentContent ?? "",
        after: asString(raw.content),
        isNew: currentContent === null,
      };
    case "edit": {
      const before = currentContent ?? "";
      const edits = asExactEdits(raw.edits);
      try {
        const after = applyExactEdits(before, edits);
        return { kind: "diff", path, before, after, isNew: false, edits };
      } catch {
        return { kind: "none" };
      }
    }
    case "delete":
      return { kind: "delete", path, content: currentContent ?? "" };
    case "rename":
      return { kind: "rename", from: path, to: asString(raw.newPath) };
    default:
      return { kind: "none" };
  }
}

export function buildExactEditPreviewWindow(
  content: string,
  edits: ExactEdit[],
  options: { contextBefore?: number; contextAfter?: number } = {},
): ExactEditPreviewWindow | null {
  let resolved: ResolvedEdit[];
  try {
    resolved = resolveExactEdits(content, edits);
  } catch {
    return null;
  }
  if (resolved.length === 0) return null;

  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const starts = lineStartOffsets(body);
  const totalLines = starts.length;
  if (totalLines === 0) return null;

  const focusStart = Math.min(...resolved.map((edit) => lineNumberAtOffset(starts, body.length, edit.start)));
  const focusEnd = Math.max(
    ...resolved.map((edit) => lineNumberAtOffset(starts, body.length, Math.max(edit.start, edit.end - 1))),
  );
  const contextBefore = Math.max(0, Math.floor(options.contextBefore ?? 10));
  const contextAfter = Math.max(0, Math.floor(options.contextAfter ?? 10));
  const sliceStartLine = Math.max(1, focusStart - contextBefore);
  const sliceEndLine = Math.min(totalLines, focusEnd + contextAfter);
  const sliceStartOffset = offsetForLine(starts, body.length, sliceStartLine);
  const sliceEndOffset = offsetForLine(starts, body.length, sliceEndLine + 1);
  const before = body.slice(sliceStartOffset, sliceEndOffset);
  const localEdits = resolved.map((edit) => ({
    ...edit,
    start: edit.start - sliceStartOffset,
    end: edit.end - sliceStartOffset,
  }));

  return {
    before,
    after: applyResolvedLocalEdits(before, localEdits),
    hiddenBefore: sliceStartLine - 1,
    hiddenAfter: totalLines - sliceEndLine,
  };
}

function lineStartOffsets(text: string): number[] {
  if (text.length === 0) return [];
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n" && index + 1 < text.length) starts.push(index + 1);
  }
  return starts;
}

function lineNumberAtOffset(starts: number[], textLength: number, offset: number): number {
  const clamped = Math.max(0, Math.min(textLength, offset));
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= clamped) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(1, high + 1);
}

function offsetForLine(starts: number[], textLength: number, line: number): number {
  if (line <= 1) return 0;
  if (line > starts.length) return textLength;
  return starts[line - 1];
}

function applyResolvedLocalEdits(content: string, edits: ResolvedEdit[]): string {
  let cursor = 0;
  let output = "";
  for (const edit of edits) {
    output += content.slice(cursor, edit.start);
    output += edit.newText;
    cursor = edit.end;
  }
  return output + content.slice(cursor);
}
