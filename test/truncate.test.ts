import { describe, expect, it } from "vitest";
import { sliceTextByLines } from "../src/vault/truncate";

const sample = "one\ntwo\nthree\nfour\nfive";

describe("sliceTextByLines", () => {
  it("returns the whole file by default", () => {
    const slice = sliceTextByLines(sample);
    expect(slice).toMatchObject({ startLine: 1, endLine: 5, totalLines: 5, truncated: false });
    expect(slice.text).toBe(sample);
  });

  it("honours a 1-based offset and limit", () => {
    const slice = sliceTextByLines(sample, { offset: 2, limit: 2 });
    expect(slice.text).toBe("two\nthree");
    expect(slice).toMatchObject({ startLine: 2, endLine: 3, truncated: true });
  });

  it("reports endLine for the lines actually emitted when the character cap cuts mid-text", () => {
    // maxCharacters lands inside the second line, so only ~1.x lines are emitted.
    const slice = sliceTextByLines(sample, { maxCharacters: 5 });
    expect(slice.truncated).toBe(true);
    // "one\nt" → one full line plus a partial second; endLine must not over-claim line 5.
    const emittedLines = slice.text.split("\n").length;
    expect(slice.endLine).toBe(slice.startLine + emittedLines - 1);
    expect(slice.endLine).toBeLessThan(slice.totalLines);
  });

  it("reports endLine = startLine - 1 for an empty selection past the end", () => {
    const slice = sliceTextByLines(sample, { offset: 99 });
    expect(slice.text).toBe("");
    expect(slice.endLine).toBe(slice.startLine - 1);
  });
});
