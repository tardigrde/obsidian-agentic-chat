import { describe, expect, it } from "vitest";
import { grepContent, matchesFindPattern } from "../src/vault/search";

describe("matchesFindPattern", () => {
  it("matches by case-insensitive substring", () => {
    expect(matchesFindPattern("Projects/Ideas.md", "ideas")).toBe(true);
    expect(matchesFindPattern("Projects/Ideas.md", "todo")).toBe(false);
  });

  it("matches simple glob patterns anchored to the whole path", () => {
    expect(matchesFindPattern("Daily/2026-06-13.md", "Daily/*.md")).toBe(true);
    expect(matchesFindPattern("Daily/2026-06-13.md", "*.txt")).toBe(false);
    expect(matchesFindPattern("a/b.md", "a/?.md")).toBe(true);
  });
});

describe("grepContent", () => {
  const content = "alpha\nBeta line\ngamma\nbeta again";

  it("finds literal matches case-insensitively by default", () => {
    const matches = grepContent("note.md", content, "beta");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ path: "note.md", lineNumber: 2 });
  });

  it("respects caseSensitive", () => {
    expect(grepContent("note.md", content, "beta", { caseSensitive: true })).toHaveLength(1);
  });

  it("supports regex matching and a match cap", () => {
    // Case-insensitive by default: "^beta" matches both "Beta line" and "beta again".
    expect(grepContent("note.md", content, "^beta", { regex: true })).toHaveLength(2);
    // Case-sensitive anchors to the lowercase line only.
    expect(grepContent("note.md", content, "^beta", { regex: true, caseSensitive: true })).toHaveLength(1);
    expect(grepContent("note.md", content, "a", { maxMatches: 1 })).toHaveLength(1);
  });
});
