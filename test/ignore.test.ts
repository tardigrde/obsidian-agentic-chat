import { describe, expect, it } from "vitest";
import { createIgnoreMatcher, parseIgnorePatterns } from "../src/vault/ignore";

function matcher(...patterns: string[]) {
  return createIgnoreMatcher(patterns);
}

describe("parseIgnorePatterns", () => {
  it("drops blank lines and comments, trims the rest", () => {
    const text = "  Private/  \n\n# a comment\n*.secret.md\n   \n";
    expect(parseIgnorePatterns(text)).toEqual(["Private/", "*.secret.md"]);
  });
});

describe("createIgnoreMatcher", () => {
  it("permits everything when there are no patterns", () => {
    const isIgnored = matcher();
    expect(isIgnored("anything.md")).toBe(false);
  });

  it("matches a bare name at any depth", () => {
    const isIgnored = matcher("secrets.md");
    expect(isIgnored("secrets.md")).toBe(true);
    expect(isIgnored("Notes/secrets.md")).toBe(true);
    expect(isIgnored("a/b/secrets.md")).toBe(true);
    expect(isIgnored("secrets.md.bak")).toBe(false);
    expect(isIgnored("not-secrets.md")).toBe(false);
  });

  it("supports * within a single path segment", () => {
    const isIgnored = matcher("*.secret.md");
    expect(isIgnored("api.secret.md")).toBe(true);
    expect(isIgnored("Folder/api.secret.md")).toBe(true);
    expect(isIgnored("api.secret.md.txt")).toBe(false);
  });

  it("does not let * cross directory separators", () => {
    const isIgnored = matcher("Inbox/*.md");
    expect(isIgnored("Inbox/a.md")).toBe(true);
    expect(isIgnored("Inbox/sub/a.md")).toBe(false);
  });

  it("supports ** across directory separators", () => {
    const isIgnored = matcher("**/diary/**");
    expect(isIgnored("a/diary/2024.md")).toBe(true);
    expect(isIgnored("diary/2024.md")).toBe(true);
    expect(isIgnored("a/b/diary/c/2024.md")).toBe(true);
    expect(isIgnored("a/calendar/2024.md")).toBe(false);
  });

  it("treats a trailing slash as the folder and everything beneath it", () => {
    const isIgnored = matcher("Private/");
    expect(isIgnored("Private")).toBe(true);
    expect(isIgnored("Private/a.md")).toBe(true);
    expect(isIgnored("Private/sub/a.md")).toBe(true);
    expect(isIgnored("Sub/Private/a.md")).toBe(true);
    expect(isIgnored("Privates/a.md")).toBe(false);
  });

  it("hides a folder's contents even without a trailing slash (no bypass)", () => {
    const isIgnored = matcher("Private");
    expect(isIgnored("Private")).toBe(true);
    expect(isIgnored("Private/Secret.md")).toBe(true);
    expect(isIgnored("Private/sub/Secret.md")).toBe(true);
    expect(isIgnored("Privates/a.md")).toBe(false);
  });

  it("anchors patterns with a leading slash to the vault root", () => {
    const isIgnored = matcher("/Inbox/passwords.md");
    expect(isIgnored("Inbox/passwords.md")).toBe(true);
    expect(isIgnored("Notes/Inbox/passwords.md")).toBe(false);
  });

  it("anchors patterns that contain a slash even without a leading slash", () => {
    const isIgnored = matcher("Inbox/passwords.md");
    expect(isIgnored("Inbox/passwords.md")).toBe(true);
    expect(isIgnored("Notes/Inbox/passwords.md")).toBe(false);
  });

  it("matches case-insensitively so casing cannot bypass a rule", () => {
    const isIgnored = matcher("secret.md");
    expect(isIgnored("Secret.md")).toBe(true);
    expect(isIgnored("SECRET.MD")).toBe(true);
  });

  it("escapes regex metacharacters in literal pattern text", () => {
    const isIgnored = matcher("a+b.md");
    expect(isIgnored("a+b.md")).toBe(true);
    expect(isIgnored("aaab.md")).toBe(false);
  });

  it("supports ? as a single non-separator character", () => {
    const isIgnored = matcher("note-?.md");
    expect(isIgnored("note-1.md")).toBe(true);
    expect(isIgnored("note-12.md")).toBe(false);
    expect(isIgnored("note-/.md")).toBe(false);
  });

  it("normalizes a leading slash on the tested path", () => {
    const isIgnored = matcher("Private/");
    expect(isIgnored("/Private/a.md")).toBe(true);
  });
});
