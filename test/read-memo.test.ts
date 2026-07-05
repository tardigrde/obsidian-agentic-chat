import { describe, expect, it } from "vitest";
import { alreadyReadMessage, ReadMemo } from "../src/vault/read-memo";

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
});
