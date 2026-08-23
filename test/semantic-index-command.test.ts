import { describe, expect, it } from "vitest";
import { parseSemanticIndexScopeCommand } from "../src/ui/semantic-index-command";

describe("semantic index command scope parsing", () => {
  it("defaults to the active note folder", () => {
    expect(parseSemanticIndexScopeCommand([], { activeNotePath: "Notes/Plans/today.md" })).toEqual({
      scope: { kind: "folder", label: "Notes/Plans", paths: ["Notes/Plans"] },
      confirmVault: false,
    });
  });

  it("refuses the implicit whole-vault scope of a root-level active note", () => {
    // folder "" matches every file in the vault; that intent must go through
    // the explicit vault confirmation instead of silently indexing everything.
    const parsed = parseSemanticIndexScopeCommand([], { activeNotePath: "Inbox.md" });
    expect(parsed).toHaveProperty("error");
    expect((parsed as { error: string }).error).toContain("--confirm-vault");
  });

  it("routes root-covering folder scopes through the vault confirmation gate", () => {
    expect(parseSemanticIndexScopeCommand(["folder", "/"])).toEqual({
      error: '"/" covers the whole vault. Re-run with --confirm-vault to index everything.',
    });
    expect(parseSemanticIndexScopeCommand(["folder", "/", "--confirm-vault"])).toEqual({
      scope: { kind: "vault", label: "Whole vault" },
      confirmVault: true,
    });
  });

  it("defaults to the active note's own folder when it is not in the vault root", () => {
    expect(parseSemanticIndexScopeCommand([], { activeNotePath: "Notes/Plans/today.md" })).toEqual({
      scope: { kind: "folder", label: "Notes/Plans", paths: ["Notes/Plans"] },
      confirmVault: false,
    });
    expect(parseSemanticIndexScopeCommand([], { activeNotePath: "Notes/today.md" })).toEqual({
      scope: { kind: "folder", label: "Notes", paths: ["Notes"] },
      confirmVault: false,
    });
  });

  it("parses explicit folder, tag, and vault scopes", () => {
    expect(parseSemanticIndexScopeCommand(["folder", "Research/Notes"])).toEqual({
      scope: { kind: "folder", label: "Research/Notes", paths: ["Research/Notes"] },
      confirmVault: false,
    });
    expect(parseSemanticIndexScopeCommand(["tag", "#meeting"])).toEqual({
      scope: { kind: "tag", label: "#meeting", tags: ["meeting"] },
      confirmVault: false,
    });
    expect(parseSemanticIndexScopeCommand(["vault", "--confirm-vault"])).toEqual({
      scope: { kind: "vault", label: "Whole vault" },
      confirmVault: true,
    });
  });

  it("returns user-facing errors for missing or invalid scopes", () => {
    expect(parseSemanticIndexScopeCommand([])).toEqual({
      error: "Choose a scope: folder <path>, tag <tag>, or vault --confirm-vault.",
    });
    expect(parseSemanticIndexScopeCommand(["folder", "../outside"])).toEqual({
      error: 'Invalid folder path "../outside".',
    });
    expect(parseSemanticIndexScopeCommand(["unknown"])).toEqual({
      error: 'Unknown semantic index scope "unknown". Use folder, tag, or vault.',
    });
  });
});
