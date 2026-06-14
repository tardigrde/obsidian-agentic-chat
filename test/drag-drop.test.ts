import { describe, expect, it } from "vitest";
import { parseDroppedVaultPath } from "../src/ui/drag-drop";

describe("parseDroppedVaultPath", () => {
  it("extracts the file path from an obsidian://open URL for the same vault", () => {
    const url = "obsidian://open?vault=MyVault&file=Projects%2Froadmap.md";
    expect(parseDroppedVaultPath(url, "MyVault")).toBe("Projects/roadmap.md");
  });

  it("decodes a multi-word path once (no double-decoding)", () => {
    const url = "obsidian://open?vault=MyVault&file=200%20Resources%2FNote.md";
    expect(parseDroppedVaultPath(url, "MyVault")).toBe("200 Resources/Note.md");
  });

  it("rejects a link pointing at a different vault", () => {
    const url = "obsidian://open?vault=Other&file=note.md";
    expect(parseDroppedVaultPath(url, "MyVault")).toBeNull();
  });

  it("accepts an obsidian URL without a vault param", () => {
    const url = "obsidian://open?file=note.md";
    expect(parseDroppedVaultPath(url, "MyVault")).toBe("note.md");
  });

  it("passes through a bare vault-relative path", () => {
    expect(parseDroppedVaultPath("Folder/Note.md", "MyVault")).toBe("Folder/Note.md");
  });

  it("rejects foreign URL schemes and empty data", () => {
    expect(parseDroppedVaultPath("https://example.com/x", "MyVault")).toBeNull();
    expect(parseDroppedVaultPath("file:///etc/passwd", "MyVault")).toBeNull();
    expect(parseDroppedVaultPath("   ", "MyVault")).toBeNull();
  });

  it("returns null for an obsidian URL with no file param", () => {
    expect(parseDroppedVaultPath("obsidian://open?vault=MyVault", "MyVault")).toBeNull();
  });
});
