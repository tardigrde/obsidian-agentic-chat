import { describe, expect, it } from "vitest";
import {
  formatSourceReference,
  normalizeObsidianLinkTarget,
  parseSourceReference,
  parseSourceReferences,
  sourceReferenceKey,
  sourceReferenceTarget,
} from "../src/retrieval/citations";

describe("parseSourceReference", () => {
  it("parses Obsidian note heading citations", () => {
    const reference = parseSourceReference("[[Projects/MCP OAuth.md#Decision log|MCP decision]]");

    expect(reference).toEqual({
      type: "note",
      path: "Projects/MCP OAuth.md",
      fragment: { type: "heading", value: "Decision log" },
      label: "MCP decision",
    });
    expect(reference && sourceReferenceTarget(reference)).toBe("Projects/MCP OAuth.md#Decision log");
    expect(reference && formatSourceReference(reference)).toBe("[[Projects/MCP OAuth.md#Decision log|MCP decision]]");
  });

  it("parses Obsidian block citations with current and legacy target styles", () => {
    expect(parseSourceReference("[[Notes/Blocks.md#^todo-block]]")).toEqual({
      type: "note",
      path: "Notes/Blocks.md",
      fragment: { type: "block", value: "todo-block" },
    });

    expect(parseSourceReference("Notes/Blocks.md^todo-block")).toEqual({
      type: "note",
      path: "Notes/Blocks.md",
      fragment: { type: "block", value: "todo-block" },
    });

    expect(parseSourceReference("^local-block")).toEqual({
      type: "note",
      fragment: { type: "block", value: "local-block" },
    });
  });

  it("parses and formats URL citations safely", () => {
    const plain = parseSourceReference("https://example.com/path?q=one");
    const labeled = parseSourceReference("[Example](https://example.com/path?q=one)");

    expect(plain).toEqual({ type: "url", url: "https://example.com/path?q=one" });
    expect(labeled).toEqual({
      type: "url",
      url: "https://example.com/path?q=one",
      label: "Example",
    });
    expect(labeled && formatSourceReference(labeled)).toBe("[Example](https://example.com/path?q=one)");
  });

  it("parses and formats source artifact citations", () => {
    const reference = parseSourceReference("[Imported PDF](artifact:tool-2026_06_26)");

    expect(reference).toEqual({
      type: "artifact",
      artifactId: "tool-2026_06_26",
      label: "Imported PDF",
    });
    expect(reference && sourceReferenceTarget(reference)).toBe("artifact:tool-2026_06_26");
    expect(reference && formatSourceReference(reference)).toBe("[Imported PDF](artifact:tool-2026_06_26)");
  });

  it("returns null for invalid or unsafe citation targets", () => {
    expect(parseSourceReference("")).toBeNull();
    expect(parseSourceReference("[[ ]]")).toBeNull();
    expect(parseSourceReference("[[Note.md# ]]")).toBeNull();
    expect(parseSourceReference("javascript:alert(1)")).toBeNull();
    expect(parseSourceReference("[bad](artifact:../../secret)")).toBeNull();
  });

  it("filters invalid entries when parsing many references", () => {
    expect(parseSourceReferences(["[[A.md]]", "", "artifact:tool-1"]).map(sourceReferenceKey)).toEqual([
      "note:a.md",
      "artifact:tool-1",
    ]);
  });
});

describe("normalizeObsidianLinkTarget", () => {
  it("normalizes paths, decoded heading fragments, and block ids", () => {
    expect(normalizeObsidianLinkTarget("/Folder//Note.md#%5Bdone%5D")).toBe("Folder/Note.md#[done]");
    expect(normalizeObsidianLinkTarget("Folder\\Note.md#^block-1")).toBe("Folder/Note.md#^block-1");
    expect(normalizeObsidianLinkTarget("^local")).toBe("^local");
  });

  it("rejects empty paths or empty fragments", () => {
    expect(normalizeObsidianLinkTarget("#Heading")).toBeNull();
    expect(normalizeObsidianLinkTarget("Note.md#")).toBeNull();
  });
});
