import { describe, expect, it } from "vitest";
import { getParentPath, normalizeFolderPath, normalizeVaultPath } from "../src/vault/path";

describe("normalizeVaultPath", () => {
  it("keeps a clean vault-relative path", () => {
    expect(normalizeVaultPath("Folder/Note.md")).toBe("Folder/Note.md");
  });

  it("strips a leading @ reference and backslashes", () => {
    expect(normalizeVaultPath("@/Folder/Note.md")).toBe("Folder/Note.md");
    expect(normalizeVaultPath("Folder\\Note.md")).toBe("Folder/Note.md");
  });

  it("rejects absolute paths", () => {
    expect(() => normalizeVaultPath("/etc/passwd")).toThrow(/vault-relative/);
  });

  it("rejects parent-directory escapes", () => {
    expect(() => normalizeVaultPath("../secrets.md")).toThrow(/'\.\.'/);
    expect(() => normalizeVaultPath("Folder/../../escape.md")).toThrow(/'\.\.'/);
  });

  it("blocks the plugin's own internals by default", () => {
    expect(() => normalizeVaultPath(".obsidian/plugins/agentic-chat/data.json")).toThrow(/plugin internals/);
  });

  it("allows plugin internals when explicitly opted in", () => {
    expect(normalizeVaultPath(".obsidian/plugins/agentic-chat/sessions/a.jsonl", { allowPluginInternals: true })).toBe(
      ".obsidian/plugins/agentic-chat/sessions/a.jsonl",
    );
  });
});

describe("normalizeFolderPath", () => {
  it("maps the current directory to the empty root", () => {
    expect(normalizeFolderPath(".")).toBe("");
    expect(normalizeFolderPath("")).toBe("");
  });
});

describe("getParentPath", () => {
  it("returns the parent folder, or empty at the root", () => {
    expect(getParentPath("a/b/c.md")).toBe("a/b");
    expect(getParentPath("c.md")).toBe("");
  });
});
