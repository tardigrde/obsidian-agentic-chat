// Adapted from lhr0909/pi-obsidian (Simon Liang), MIT License.
// https://github.com/lhr0909/pi-obsidian
export interface TextSliceOptions {
  offset?: number;
  limit?: number;
  maxCharacters?: number;
}

export interface TextSlice {
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 50_000;

/** Slice text by 1-based line `offset` and `limit`, capped at `maxCharacters`. */
export function sliceTextByLines(content: string, options: TextSliceOptions = {}): TextSlice {
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(1, options.offset ?? 1);
  const startIndex = startLine - 1;
  const requestedEnd = options.limit === undefined ? lines.length : startIndex + Math.max(0, options.limit);
  const selectedLines = lines.slice(startIndex, requestedEnd);
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARS;
  const joined = selectedLines.join("\n");
  const text = joined.length > maxCharacters ? joined.slice(0, maxCharacters) : joined;
  // When a character cap cuts mid-text, fewer lines are actually emitted than
  // were selected; report the last line the emitted text really reaches so the
  // "lines X-Y" header doesn't over-claim.
  // Empty text means nothing was emitted (no lines selected, or a 0-char cap);
  // "".split("\n") would otherwise miscount as 1.
  const emittedLineCount = text === "" ? 0 : text.split("\n").length;

  return {
    text,
    startLine,
    endLine: emittedLineCount === 0 ? startLine - 1 : startLine + emittedLineCount - 1,
    totalLines: lines.length,
    truncated: requestedEnd < lines.length || joined.length > maxCharacters,
  };
}

export function formatTextSlice(path: string, slice: TextSlice): string {
  const header = `${path} lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines}${
    slice.truncated ? " (truncated)" : ""
  }`;
  return `${header}\n${slice.text}`;
}

export function truncateToolOutput(text: string, maxCharacters = DEFAULT_MAX_CHARS): string {
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters)}\n\n[Output truncated at ${maxCharacters} characters.]`;
}

/** Above this size, a bulk `read` (no offset/limit) is refused with guidance to paginate. */
export const READ_BULK_LIMIT = 50_000;

/**
 * Guardrail for a bulk `read`: when a note is larger than the limit and the
 * caller didn't narrow the range (offset/limit), return guidance instead of
 * dumping the whole file — a single huge file can otherwise consume most of the
 * model's context window in one tool call. Paginated reads are always allowed
 * (the model is being deliberate). Returns the guidance string, or null when the
 * read should proceed.
 */
export function readSizeGuardrail(params: {
  path: string;
  size: number;
  offset?: number;
  limit?: number;
  maxChars?: number;
}): string | null {
  const maxChars = params.maxChars ?? READ_BULK_LIMIT;
  if (params.offset !== undefined || params.limit !== undefined) return null;
  if (!Number.isFinite(params.size) || params.size <= maxChars) return null;
  const chars = Math.round(params.size);
  return (
    `"${params.path}" is large (~${chars.toLocaleString()} bytes). Reading it in full risks filling the ` +
    "context window. Read a slice with offset/limit, or use grep/find to locate the part you need first."
  );
}
