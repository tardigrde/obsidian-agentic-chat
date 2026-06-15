/** One line of a unified-style diff. */
export interface DiffLine {
  op: "add" | "remove" | "context";
  text: string;
}

/** Counts of changed lines, for a compact summary. */
export interface DiffStat {
  added: number;
  removed: number;
}

/**
 * Above this many DP cells (before-lines × after-lines) we skip the line-level
 * LCS and let callers fall back to a summary, so a huge file can't lock the UI
 * on an O(m·n) table.
 */
export const MAX_DIFF_CELLS = 250_000;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  // Treat a single trailing newline as a line terminator, not a final empty
  // line: "a\n" is one line ("a"), same as "a". Otherwise vault content (which
  // usually ends in "\n") would show a phantom empty-line removal whenever the
  // model's after-content omits the trailing newline, and stat counts/the
  // "X → Y lines" summary would be off by one.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n");
}

/** True when an exact line diff would be too large to compute cheaply. */
export function diffTooLarge(before: string, after: string): boolean {
  const m = splitLines(before).length;
  const n = splitLines(after).length;
  return m * n > MAX_DIFF_CELLS;
}

/**
 * Line-level diff via longest-common-subsequence. Returns the ordered op list
 * (removals before additions at each divergence). Throws when the input is too
 * large — guard with {@link diffTooLarge} first.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const m = a.length;
  const n = b.length;
  if (m * n > MAX_DIFF_CELLS) throw new Error("Diff input too large.");

  // dp[i*stride + j] = LCS length of a[i:] and b[j:]. A single flat Int32Array
  // (one contiguous block, no per-row object overhead) keeps memory and GC flat
  // for inputs near the cell cap.
  const stride = n + 1;
  const dp = new Int32Array((m + 1) * stride);
  for (let i = m - 1; i >= 0; i--) {
    const row = i * stride;
    const nextRow = (i + 1) * stride;
    for (let j = n - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j] ? dp[nextRow + j + 1] + 1 : Math.max(dp[nextRow + j], dp[row + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ op: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      out.push({ op: "remove", text: a[i] });
      i++;
    } else {
      out.push({ op: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ op: "remove", text: a[i++] });
  while (j < n) out.push({ op: "add", text: b[j++] });
  return out;
}

/** Added/removed line counts for a diff op list. */
export function diffStat(lines: DiffLine[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.op === "add") added++;
    else if (line.op === "remove") removed++;
  }
  return { added, removed };
}
