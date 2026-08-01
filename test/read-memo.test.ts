import { describe, expect, it } from "vitest";
import { alreadyReadMessage, coveredReadMessage, ReadMemo } from "../src/vault/read-memo";

describe("ReadMemo", () => {
  it("reports a path/range as unseen before mark, seen after", () => {
    const memo = new ReadMemo();
    expect(memo.has({ path: "Note.md" })).toBe(false);
    memo.mark({ path: "Note.md" });
    expect(memo.has({ path: "Note.md" })).toBe(true);
  });

  it("treats a different range as a fresh read", () => {
    const memo = new ReadMemo();
    memo.mark({ path: "Note.md" });
    expect(memo.has({ path: "Note.md", offset: 1, limit: 10 })).toBe(false);
    memo.mark({ path: "Note.md", offset: 1, limit: 10 });
    expect(memo.has({ path: "Note.md", offset: 1, limit: 10 })).toBe(true);
  });

  it("invalidate makes the next read of that path fresh", () => {
    const memo = new ReadMemo();
    memo.mark({ path: "Note.md" });
    memo.invalidate("Note.md");
    expect(memo.has({ path: "Note.md" })).toBe(false);
  });

  it("invalidate only affects the named path, not a sibling with a shared prefix", () => {
    const memo = new ReadMemo();
    memo.mark({ path: "Note.md" });
    memo.mark({ path: "Note.md2" });
    memo.invalidate("Note.md");
    expect(memo.has({ path: "Note.md" })).toBe(false);
    // The prefix-named file is untouched.
    expect(memo.has({ path: "Note.md2" })).toBe(true);
  });

  it("clear drops every recorded read", () => {
    const memo = new ReadMemo();
    memo.mark({ path: "Note.md" });
    memo.clear();
    expect(memo.has({ path: "Note.md" })).toBe(false);
  });

  it("alreadyReadMessage points back at the path", () => {
    expect(alreadyReadMessage("Folder/Note.md")).toContain("Folder/Note.md");
    expect(alreadyReadMessage("Folder/Note.md")).toContain("startLine/endLine");
    expect(alreadyReadMessage("Folder/Note.md")).toContain("offset/limit");
  });

  it("coverageFor matches a range contained inside an earlier served window", () => {
    const memo = new ReadMemo();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: "ten lines" }, 5, false);
    expect(memo.coverageFor({ path: "Note.md", start: 3, end: 6, toEnd: false }, 5)).toEqual({
      full: false,
      quote: "ten lines",
    });
  });

  it("coverageFor ignores a window served at a different mtime", () => {
    const memo = new ReadMemo();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: "old" }, 5, false);
    expect(memo.coverageFor({ path: "Note.md", start: 1, end: 10, toEnd: false }, 9)).toBeNull();
  });

  it("coverageFor rejects a range that extends past the earlier window", () => {
    const memo = new ReadMemo();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: "ten lines" }, 5, false);
    expect(memo.coverageFor({ path: "Note.md", start: 5, end: 12, toEnd: false }, 5)).toBeNull();
  });

  it("coverageFor only satisfies a to-end request with a previous full read", () => {
    const memo = new ReadMemo();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: "partial" }, 5, false);
    expect(memo.coverageFor({ path: "Note.md", start: 1, end: 0, toEnd: true }, 5)).toBeNull();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: "whole file" }, 5, true);
    expect(memo.coverageFor({ path: "Note.md", start: 1, end: 0, toEnd: true }, 5)?.full).toBe(true);
  });

  it("coverageFor picks the tightest containing window and caps the quote", () => {
    const memo = new ReadMemo();
    const wide = "w".repeat(1_000);
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 50, content: wide }, 5, false);
    memo.recordCoverage({ path: "Note.md", startLine: 10, endLine: 20, content: "tight" }, 5, false);
    const match = memo.coverageFor({ path: "Note.md", start: 12, end: 14, toEnd: false }, 5);
    expect(match?.quote).toBe("tight");
    const capped = memo.coverageFor({ path: "Note.md", start: 2, end: 4, toEnd: false }, 5);
    expect(capped?.quote.length).toBeLessThan(wide.length);
    expect(capped?.quote).toMatch(/…$/);
  });

  it("invalidate drops coverage for the named path", () => {
    const memo = new ReadMemo();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: "x" }, 5, false);
    memo.recordCoverage({ path: "Note.md2", startLine: 1, endLine: 10, content: "y" }, 5, false);
    memo.invalidate("Note.md");
    expect(memo.coverageFor({ path: "Note.md", start: 1, end: 10, toEnd: false }, 5)).toBeNull();
    expect(memo.coverageFor({ path: "Note.md2", start: 1, end: 10, toEnd: false }, 5)).not.toBeNull();
  });

  it("clear drops every recorded coverage window", () => {
    const memo = new ReadMemo();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: "x" }, 5, true);
    memo.clear();
    expect(memo.coverageFor({ path: "Note.md", start: 1, end: 0, toEnd: true }, 5)).toBeNull();
  });

  it("coveredReadMessage names the file and includes the quoted content", () => {
    const message = coveredReadMessage("Folder/Note.md", { full: true, quote: "hello world" });
    expect(message).toContain("Folder/Note.md");
    expect(message).toContain("hello world");
    expect(message).toContain("grep");
  });
});
