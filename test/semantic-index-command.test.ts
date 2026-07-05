import { describe, expect, it } from "vitest";
import { parseSemanticIndexScopeCommand } from "../src/ui/semantic-index-command";

const project = {
  name: "Client Work",
  folders: ["Clients/Acme", "Clients/Globex"],
};

describe("semantic index command scope parsing", () => {
  it("defaults to the active project when one is present", () => {
    expect(parseSemanticIndexScopeCommand([], { activeProject: project })).toEqual({
      scope: { kind: "project", label: "Client Work", paths: ["Clients/Acme", "Clients/Globex"] },
      confirmVault: false,
    });
  });

  it("defaults to the active note folder without an active project", () => {
    expect(parseSemanticIndexScopeCommand([], { activeNotePath: "Notes/Plans/today.md" })).toEqual({
      scope: { kind: "folder", label: "Notes/Plans", paths: ["Notes/Plans"] },
      confirmVault: false,
    });
  });

  it("uses the vault root folder label for root-level active notes and folder slash", () => {
    expect(parseSemanticIndexScopeCommand([], { activeNotePath: "Inbox.md" })).toEqual({
      scope: { kind: "folder", label: "/", paths: [""] },
      confirmVault: false,
    });
    expect(parseSemanticIndexScopeCommand(["folder", "/"])).toEqual({
      scope: { kind: "folder", label: "/", paths: [""] },
      confirmVault: false,
    });
  });

  it("parses explicit folder, tag, project, and vault scopes", () => {
    expect(parseSemanticIndexScopeCommand(["folder", "Research/Notes"])).toEqual({
      scope: { kind: "folder", label: "Research/Notes", paths: ["Research/Notes"] },
      confirmVault: false,
    });
    expect(parseSemanticIndexScopeCommand(["tag", "#meeting"])).toEqual({
      scope: { kind: "tag", label: "#meeting", tags: ["meeting"] },
      confirmVault: false,
    });
    expect(parseSemanticIndexScopeCommand(["project"], { activeProject: project })).toEqual({
      scope: { kind: "project", label: "Client Work", paths: ["Clients/Acme", "Clients/Globex"] },
      confirmVault: false,
    });
    expect(parseSemanticIndexScopeCommand(["vault", "--confirm-vault"])).toEqual({
      scope: { kind: "vault", label: "Whole vault" },
      confirmVault: true,
    });
  });

  it("returns user-facing errors for missing or invalid scopes", () => {
    expect(parseSemanticIndexScopeCommand([])).toEqual({
      error: "Choose a scope: folder <path>, tag <tag>, project, or vault --confirm-vault.",
    });
    expect(parseSemanticIndexScopeCommand(["project"])).toEqual({
      error: "No project is active. Use /project first, or choose a folder/tag/vault scope.",
    });
    expect(parseSemanticIndexScopeCommand(["folder", "../outside"])).toEqual({
      error: 'Invalid folder path "../outside".',
    });
    expect(parseSemanticIndexScopeCommand(["unknown"])).toEqual({
      error: 'Unknown semantic index scope "unknown". Use folder, tag, project, or vault.',
    });
  });
});
