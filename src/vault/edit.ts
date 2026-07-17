// Adapted from lhr0909/pi-obsidian (Simon Liang), MIT License.
// https://github.com/lhr0909/pi-obsidian
export interface ExactEdit {
  oldText: string;
  newText: string;
}

export interface ResolvedEdit extends ExactEdit {
  start: number;
  end: number;
}

/**
 * Apply one or more exact string replacements. Each `oldText` must occur
 * exactly once and edits must not overlap, mirroring coding-agent edit
 * semantics so the model gets a clear error instead of silent corruption.
 */
export function applyExactEdits(content: string, edits: ExactEdit[]): string {
  return applyResolvedEdits(content, resolveExactEdits(content, edits));
}

export function resolveExactEdits(content: string, edits: ExactEdit[]): ResolvedEdit[] {
  if (edits.length === 0) {
    throw new Error("At least one edit is required.");
  }

  const resolvedEdits = edits
    .map((edit) => resolveEdit(content, edit))
    .sort((left, right) => left.start - right.start);
  assertNoOverlaps(resolvedEdits);
  return resolvedEdits;
}

function resolveEdit(content: string, edit: ExactEdit): ResolvedEdit {
  if (!edit.oldText) {
    throw new Error("oldText must not be empty.");
  }
  if (edit.oldText === edit.newText) {
    throw new Error(
      "Edit produced no change (oldText === newText). Re-read the current content and choose an oldText that differs from newText.",
    );
  }

  const start = content.indexOf(edit.oldText);
  if (start !== -1) {
    if (content.indexOf(edit.oldText, start + edit.oldText.length) !== -1) {
      throw new Error(`oldText must match exactly once: ${preview(edit.oldText)}`);
    }
    return { ...edit, start, end: start + edit.oldText.length };
  }

  // Fallback: a PII scrubber (provider/proxy) may have replaced sensitive spans
  // in the model's output with placeholders like [EMAIL], so the oldText the
  // model wrote no longer matches the real file byte-for-byte. Treat known
  // placeholders as wildcards and match the real content. Only used when the
  // exact match fails AND the oldText contains a placeholder.
  const ph = placeholderMatchRegex(edit.oldText);
  if (ph) {
    const matches = [...content.matchAll(ph.regex)];
    if (matches.length === 1) {
      const match = matches[0];
      const index = match.index ?? 0;
      const matchedText = match[0];
      // Extract real values from capturing groups and substitute into newText
      // so the file gets real content (e.g. alice@ex.com) not the placeholder ([EMAIL]).
      const realGroups = ph.placeholders.map((_, i) => match[i + 1] ?? "");
      const resolvedNewText = substitutePlaceholders(edit.newText, ph.placeholders, realGroups);
      return { oldText: matchedText, newText: resolvedNewText, start: index, end: index + matchedText.length };
    }
    if (matches.length > 1) {
      throw new Error(
        `oldText matches ${matches.length} times after resolving redacted placeholders; add more surrounding context: ${preview(edit.oldText)}`,
      );
    }
  }

  throw new Error(`oldText was not found: ${preview(edit.oldText)}${fuzzyHint(content, edit.oldText)}`);
}

function assertNoOverlaps(edits: ResolvedEdit[]): void {
  for (let index = 1; index < edits.length; index += 1) {
    const previous = edits[index - 1];
    const current = edits[index];
    if (previous && current && current.start < previous.end) {
      throw new Error("Edits must not overlap.");
    }
  }
}

function applyResolvedEdits(content: string, edits: ResolvedEdit[]): string {
  let cursor = 0;
  let output = "";
  for (const edit of edits) {
    output += content.slice(cursor, edit.start);
    output += edit.newText;
    cursor = edit.end;
  }
  return output + content.slice(cursor);
}

export interface EditApplyFailure {
  edit: ExactEdit;
  error: string;
}

export interface EditApplyResult {
  /** New file content after applying the non-overlapping subset that resolved. */
  content: string;
  /** Edits that resolved and were applied. */
  applied: ResolvedEdit[];
  /** Edits that did not resolve or overlapped an applied edit, with the reason. */
  failed: EditApplyFailure[];
}

/**
 * Resolve and apply edits individually: the edits that match are applied, the
 * rest are reported as failures instead of sinking the whole batch. Overlapping
 * resolved edits are dropped (greedy, left-to-right) so the applied set never
 * conflicts. Used by the edit tool so one bad oldText no longer discards nine
 * good edits; the atomic {@link applyExactEdits} stays for previews.
 */
export function applyExactEditsPartial(content: string, edits: ExactEdit[]): EditApplyResult {
  if (edits.length === 0) {
    throw new Error("At least one edit is required.");
  }

  const failed: EditApplyFailure[] = [];
  const resolved: ResolvedEdit[] = [];
  for (const edit of edits) {
    try {
      resolved.push(resolveEdit(content, edit));
    } catch (error) {
      failed.push({ edit, error: error instanceof Error ? error.message : String(error) });
    }
  }

  resolved.sort((left, right) => left.start - right.start);
  const applied: ResolvedEdit[] = [];
  let lastEnd = -1;
  for (const candidate of resolved) {
    if (candidate.start < lastEnd) {
      failed.push({ edit: candidate, error: "Edits must not overlap." });
      continue;
    }
    applied.push(candidate);
    lastEnd = candidate.end;
  }

  const nextContent = applied.length > 0 ? applyResolvedEdits(content, applied) : content;
  return { content: nextContent, applied, failed };
}

/** PII placeholders a scrubber may substitute into model output (case-insensitive). */
const PLACEHOLDER_PATTERN = /\[(?:EMAIL|PHONE|REDACTED)\]/gi;

/** Wildcard each placeholder becomes when matching oldText against real content. */
const PLACEHOLDER_WILDCARDS: Record<string, string> = {
  "[email]": String.raw`[A-Za-z0-9._%'+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
  "[phone]": String.raw`[0-9 +()\-]{4,}`,
  "[redacted]": String.raw`[^\]\[]{0,120}`,
};

interface PlaceholderRegex {
  regex: RegExp;
  placeholders: string[];
}

/**
 * Build a regex that treats PII placeholders in `oldText` as wildcards, escaping
 * everything else literally. Each wildcard is wrapped in a capturing group so the
 * caller can extract the real values and substitute them back into `newText`.
 * Returns null when `oldText` has no placeholder (so callers keep the fast
 * exact-match path).
 */
function placeholderMatchRegex(oldText: string): PlaceholderRegex | null {
  const matches = [...oldText.matchAll(PLACEHOLDER_PATTERN)];
  if (matches.length === 0) return null;
  const placeholders: string[] = [];
  let pattern = "";
  let last = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    pattern += escapeRegExp(oldText.slice(last, index));
    const wildcard = PLACEHOLDER_WILDCARDS[match[0].toLowerCase()] ?? String.raw`[^\]]{0,120}`;
    pattern += `(${wildcard})`;
    placeholders.push(match[0].toLowerCase());
    last = index + match[0].length;
  }
  pattern += escapeRegExp(oldText.slice(last));
  return { regex: new RegExp(pattern, "g"), placeholders };
}

/**
 * Substitute PII placeholders in `text` with real values extracted from a
 * regex match. For example, given text `"mailto:[EMAIL]"`, placeholders
 * `["[email]"]`, and groups `["alice@ex.com"]`, returns `"mailto:alice@ex.com"`.
 */
function substitutePlaceholders(text: string, placeholders: string[], groups: string[]): string {
  let result = text;
  for (let i = 0; i < placeholders.length; i++) {
    const placeholder = placeholders[i];
    const real = groups[i];
    if (real !== undefined) {
      result = result.replace(new RegExp(escapeRegExp(placeholder), "gi"), real);
    }
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function preview(text: string): string {
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}

const MAX_FUZZY_LINE_LENGTH = 200;

/**
 * Cheap token-overlap hint: find the 1–2 lines in `content` most similar to
 * `oldText` and return a human-readable snippet the model can use to self-correct.
 * Returns "" when the file is empty or has no meaningful overlap.
 */
function fuzzyHint(content: string, oldText: string): string {
  if (!content) return "";
  const queryTokens = tokenize(oldText);
  if (queryTokens.size === 0) return "";

  const lines = content.split("\n");
  let bestScore = 0;
  let bestLine = "";
  let bestIndex = 0;
  let secondScore = 0;
  let secondLine = "";
  let secondIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const score = jaccard(queryTokens, tokenize(line));
    if (score > bestScore) {
      secondScore = bestScore;
      secondLine = bestLine;
      secondIndex = bestIndex;
      bestScore = score;
      bestLine = line;
      bestIndex = i;
    } else if (score > secondScore) {
      secondScore = score;
      secondLine = line;
      secondIndex = i;
    }
  }

  if (bestScore === 0) return "";

  const truncate = (s: string) =>
    s.length > MAX_FUZZY_LINE_LENGTH ? `${s.slice(0, MAX_FUZZY_LINE_LENGTH - 3)}...` : s;

  let hint = `\nClosest match (line ${bestIndex + 1}): ${truncate(bestLine.trim())}`;
  if (secondScore > 0.15) {
    hint += `\nNext closest (line ${secondIndex + 1}): ${truncate(secondLine.trim())}`;
  }
  return hint;
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/\s+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
