import { describe, expect, it } from "vitest";
import { readSizeGuardrail, READ_BULK_LIMIT, sliceTextByLines } from "../src/vault/truncate";

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

  it("does not over-count when a zero-character cap emits no text", () => {
    const slice = sliceTextByLines(sample, { maxCharacters: 0 });
    expect(slice.text).toBe("");
    expect(slice.endLine).toBe(slice.startLine - 1);
    expect(slice.truncated).toBe(true);
  });
});

describe("readSizeGuardrail", () => {
  it("allows a small bulk read", () => {
    expect(readSizeGuardrail({ path: "Note.md", size: 500 })).toBeNull();
  });

  it("refuses a bulk read above the limit with pagination guidance", () => {
    const message = readSizeGuardrail({ path: "Big.md", size: READ_BULK_LIMIT + 1 });
    expect(message).not.toBeNull();
    expect(message).toContain("Big.md");
    expect(message).toContain("offset/limit");
  });

  it("always allows a paginated read (offset or limit) regardless of size", () => {
    expect(readSizeGuardrail({ path: "Big.md", size: 1_000_000, offset: 1 })).toBeNull();
    expect(readSizeGuardrail({ path: "Big.md", size: 1_000_000, limit: 100 })).toBeNull();
  });

  it("treats an unknown size as no guardrail", () => {
    expect(readSizeGuardrail({ path: "Note.md", size: 0 })).toBeNull();
    expect(readSizeGuardrail({ path: "Note.md", size: Number.NaN })).toBeNull();
  });
});
