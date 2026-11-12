import { diffLines, diffStat, diffTooLarge } from "../../vault/diff";

/** Produce a concise diff summary (≤20 lines) of the changed regions. */
export function buildEditDiffSummary(before: string, after: string): string {
  if (before === after) return "";
  if (diffTooLarge(before, after)) {
    const beforeLines = before.split(/\r?\n/).length;
    const afterLines = after.split(/\r?\n/).length;
    return `Diff: ${beforeLines} → ${afterLines} lines (too large to inline).`;
  }
  const lines = diffLines(before, after);
  const stat = diffStat(lines);
  const hunks = collectDiffHunks(lines);
  const header = `Diff summary (+${stat.added}/-${stat.removed} lines):`;
  if (hunks.length === 0) return header;
  return `${header}\n${formatDiffPreview(hunks, 20)}`;
}

function collectDiffHunks(lines: { op: string; text: string }[]): string[] {
  const hunks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      hunks.push(current.join("\n"));
      current = [];
    }
  };
  for (const line of lines) {
    if (line.op === "context") {
      if (current.length > 0 && current[current.length - 1].startsWith(" ")) {
        current.push(` ${line.text}`);
      } else {
        flush();
      }
    } else {
      const prefix = line.op === "add" ? "+" : "-";
      current.push(`${prefix} ${line.text}`);
    }
  }
  flush();
  return hunks;
}

function formatDiffPreview(hunks: string[], maxLines: number): string {
  const joined = hunks.join("\n\n");
  const preview = joined.split("\n").slice(0, maxLines).join("\n");
  const omitted = joined.split("\n").length - maxLines;
  return `${preview}${omitted > 0 ? `\n... (${omitted} more lines)` : ""}`;
}

export function formatEditFailures(failed: { error: string }[]): string {
  return failed.map((failure) => `- ${failure.error}`).join("\n");
}
