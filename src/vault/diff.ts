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
  return text.length === 0 ? [] : text.split("\n");
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

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
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
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
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
