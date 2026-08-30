import { describe, it, expect } from "vitest";
import {
  createFileSystemDenyMatcher,
  createFileSystemSandboxPolicy,
  PROTECTED_DENY_GLOBS,
} from "../src/vault/file-system-sandbox";
import { createIgnoreMatcher, parseIgnorePatterns } from "../src/vault/ignore";

describe("file-system-sandbox", () => {
  it("exposes protected globs", () => {
    expect(PROTECTED_DENY_GLOBS).toContain("." + "obsidian");
    expect(PROTECTED_DENY_GLOBS).toContain(".git");
    expect(PROTECTED_DENY_GLOBS).toContain(".trash");
  });

  it("denies protected paths even with empty user globs", () => {
    const isDenied = createFileSystemDenyMatcher("");
    expect(isDenied(".obsidian/app.json")).toBe(true);
    expect(isDenied(".obsidian/plugins/agentic-chat/main.js")).toBe(true);
    expect(isDenied(".git/HEAD")).toBe(true);
    expect(isDenied(".trash/note.md")).toBe(true);
    expect(isDenied("Notes/note.md")).toBe(false);
    expect(isDenied("README.md")).toBe(false);
  });

  it("merges user globs with protected globs", () => {
    const isDenied = createFileSystemDenyMatcher("Private/**\n*.secret.md");
    expect(isDenied("Private/note.md")).toBe(true);
    expect(isDenied("Notes/secret.secret.md")).toBe(true);
    expect(isDenied(".obsidian/config")).toBe(true);
    expect(isDenied("Notes/ok.md")).toBe(false);
  });

  it("is case-insensitive like ignore matcher", () => {
    const isDenied = createFileSystemDenyMatcher("Private/**");
    expect(isDenied("private/note.md")).toBe(true);
    expect(isDenied("PRIVATE/NOTE.MD")).toBe(true);
    expect(isDenied(".OBSIDIAN/app.json")).toBe(true);
  });

  it("policy exposes effective patterns", () => {
    const policy = createFileSystemSandboxPolicy("Private/**");
    expect(policy.userGlobs).toBe("Private/**");
    expect(policy.effectivePatterns).toContain("Private/**");
    expect(policy.effectivePatterns).toContain(".obsidian");
    expect(policy.isDenied("Private/x.md")).toBe(true);
    expect(policy.isDenied(".git/config")).toBe(true);
  });

  it("user globs with trailing slash and leading slash behave like ignore", () => {
    const isDenied = createFileSystemDenyMatcher("Private/\n/Secret.md");
    expect(isDenied("Private/note.md")).toBe(true);
    expect(isDenied("Private")).toBe(true);
    expect(isDenied("Secret.md")).toBe(true);
    expect(isDenied("Notes/Secret.md")).toBe(false);
  });

  it("folder pattern hides subtree", () => {
    const isDenied = createFileSystemDenyMatcher("Private");
    expect(isDenied("Private")).toBe(true);
    expect(isDenied("Private/Secret.md")).toBe(true);
    expect(isDenied("Private/Sub/file.md")).toBe(true);
    expect(isDenied("NotPrivate/file.md")).toBe(false);
  });

  it("protected patterns also hide subtree", () => {
    const isDenied = createFileSystemDenyMatcher("");
    expect(isDenied(".obsidian")).toBe(true);
    expect(isDenied(".obsidian/workspace.json")).toBe(true);
    expect(isDenied(".git")).toBe(true);
    expect(isDenied(".git/objects/abc")).toBe(true);
  });

  it("does not allow un-ignoring protected paths via user globs", () => {
    // Even if user tries to not list protected, they remain denied
    const isDenied = createFileSystemDenyMatcher("! .obsidian/**");
    // Negation not supported — treated as literal, so still denied via protected
    expect(isDenied(".obsidian/app.json")).toBe(true);
  });

  it("matches createIgnoreMatcher behavior for user patterns when protected ignored", () => {
    const userMatcher = createIgnoreMatcher(parseIgnorePatterns("Private/**"));
    const sandboxMatcher = createFileSystemDenyMatcher("Private/**");
    // User pattern matches same
    expect(userMatcher("Private/note.md")).toBe(true);
    expect(sandboxMatcher("Private/note.md")).toBe(true);
    // Sandbox additionally denies protected
    expect(userMatcher(".obsidian/app.json")).toBe(false);
    expect(sandboxMatcher(".obsidian/app.json")).toBe(true);
  });
});
