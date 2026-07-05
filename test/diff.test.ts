import { describe, expect, it } from "vitest";
import { compactDiffLines, diffLines, diffStat, diffTooLarge, MAX_DIFF_CELLS } from "../src/vault/diff";

describe("diffLines", () => {
  it("marks added, removed, and context lines", () => {
    const before = "a\nb\nc";
    const after = "a\nB\nc\nd";
    const lines = diffLines(before, after);
    expect(lines).toEqual([
      { op: "context", text: "a" },
      { op: "remove", text: "b" },
      { op: "add", text: "B" },
      { op: "context", text: "c" },
      { op: "add", text: "d" },
    ]);
  });

  it("treats an empty before as all additions (new file)", () => {
    const lines = diffLines("", "x\ny");
    expect(diffStat(lines)).toEqual({ added: 2, removed: 0 });
  });

  it("treats an empty after as all removals (delete)", () => {
    const lines = diffLines("x\ny", "");
    expect(diffStat(lines)).toEqual({ added: 0, removed: 2 });
  });

  it("returns only context when nothing changed", () => {
    const lines = diffLines("a\nb", "a\nb");
    expect(diffStat(lines)).toEqual({ added: 0, removed: 0 });
    expect(lines.every((line) => line.op === "context")).toBe(true);
  });

  it("treats a trailing newline as a terminator, not a phantom empty line", () => {
    // Vault content usually ends in "\n"; an after with the same text but no
    // trailing newline must not register a spurious empty-line change.
    const lines = diffLines("a\nb\n", "a\nb");
    expect(diffStat(lines)).toEqual({ added: 0, removed: 0 });
    expect(lines.every((line) => line.op === "context")).toBe(true);
  });
});

describe("diffTooLarge", () => {
  it("flags inputs whose DP table would exceed the cell cap", () => {
    const big = Array.from({ length: 600 }, (_, i) => String(i)).join("\n"); // 600×600 = 360k > cap
    expect(diffTooLarge(big, big)).toBe(true);
    expect(600 * 600).toBeGreaterThan(MAX_DIFF_CELLS);
  });

  it("allows ordinary-sized inputs", () => {
    expect(diffTooLarge("a\nb\nc", "a\nb\nd")).toBe(false);
  });
});

describe("compactDiffLines", () => {
  it("shows ten context lines around a middle change by default", () => {
    const before = Array.from({ length: 31 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 16", "line sixteen");
    const windowed = compactDiffLines(diffLines(before, after));

    expect(windowed.hiddenBefore).toBe(5);
    expect(windowed.hiddenAfter).toBe(5);
    expect(windowed.lines[0]).toEqual({ op: "context", text: "line 6" });
    expect(windowed.lines.at(-1)).toEqual({ op: "context", text: "line 26" });
    expect(windowed.lines.some((line) => line.op === "remove" && line.text === "line 16")).toBe(true);
    expect(windowed.lines.some((line) => line.op === "add" && line.text === "line sixteen")).toBe(true);
  });

  it("expands the visible window when callers increase context", () => {
    const before = Array.from({ length: 31 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 16", "line sixteen");
    const windowed = compactDiffLines(diffLines(before, after), { contextBefore: 20, contextAfter: 20 });

    expect(windowed.hiddenBefore).toBe(0);
    expect(windowed.hiddenAfter).toBe(0);
    expect(windowed.lines[0]).toEqual({ op: "context", text: "line 1" });
    expect(windowed.lines.at(-1)).toEqual({ op: "context", text: "line 31" });
  });
});
