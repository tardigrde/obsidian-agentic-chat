import { describe, expect, it } from "vitest";
import { diffLines, diffStat, diffTooLarge, MAX_DIFF_CELLS } from "../src/vault/diff";

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
