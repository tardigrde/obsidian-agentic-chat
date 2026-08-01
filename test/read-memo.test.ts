import { describe, expect, it } from "vitest";
import { alreadyReadMessage, coveredReadMessage, ReadMemo } from "../src/vault/read-memo";

/** Multi-line content where line N of the window is literally "lineN". */
function windowContent(start: number, end: number): string {
  return Array.from({ length: end - start + 1 }, (_, i) => `line${start + i}`).join("\n");
}

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
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: windowContent(1, 10) }, 5, false);
    expect(memo.coverageFor({ path: "Note.md", start: 3, end: 6, toEnd: false }, 5)).toEqual({
      full: false,
      quote: "line3\nline4\nline5\nline6",
    });
  });

  it("coverageFor ignores a window served at a different mtime", () => {
    const memo = new ReadMemo();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: windowContent(1, 10) }, 5, false);
    expect(memo.coverageFor({ path: "Note.md", start: 1, end: 10, toEnd: false }, 9)).toBeNull();
  });

  it("coverageFor rejects a range that extends past the earlier window", () => {
    const memo = new ReadMemo();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: windowContent(1, 10) }, 5, false);
    expect(memo.coverageFor({ path: "Note.md", start: 5, end: 12, toEnd: false }, 5)).toBeNull();
  });

  it("coverageFor only satisfies a to-end request with a previous full read", () => {
    const memo = new ReadMemo();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: windowContent(1, 10) }, 5, false);
    expect(memo.coverageFor({ path: "Note.md", start: 1, end: 0, toEnd: true }, 5)).toBeNull();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 10, content: windowContent(1, 10) }, 5, true);
    expect(memo.coverageFor({ path: "Note.md", start: 1, end: 0, toEnd: true }, 5)?.full).toBe(true);
  });

  it("quotes the requested lines even when they are late in a wide window", () => {
    const memo = new ReadMemo();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 50, content: windowContent(1, 50) }, 5, false);
    const match = memo.coverageFor({ path: "Note.md", start: 45, end: 48, toEnd: false }, 5);
    expect(match?.quote).toBe("line45\nline46\nline47\nline48");
  });

  it("coverageFor picks the tightest containing window", () => {
    const memo = new ReadMemo();
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 50, content: windowContent(1, 50) }, 5, false);
    memo.recordCoverage({ path: "Note.md", startLine: 10, endLine: 20, content: windowContent(10, 20) }, 5, false);
    const match = memo.coverageFor({ path: "Note.md", start: 12, end: 14, toEnd: false }, 5);
    expect(match?.quote).toBe("line12\nline13\nline14");
  });

  it("coverageFor caps the quote at the character limit", () => {
    const memo = new ReadMemo();
    const wide = Array.from({ length: 50 }, () => "x".repeat(40)).join("\n");
    memo.recordCoverage({ path: "Note.md", startLine: 1, endLine: 50, content: wide }, 5, false);
    const capped = memo.coverageFor({ path: "Note.md", start: 1, end: 50, toEnd: false }, 5);
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
