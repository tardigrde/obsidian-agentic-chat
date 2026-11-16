import { describe, expect, it } from "vitest";
import { createArtifactTool } from "../src/artifacts/tool-artifact-tools";
import type { ToolArtifactMetadata, ToolArtifactStoreLike } from "../src/artifacts/tool-artifact-store";
import { unwrapToolOutput } from "../src/tools/tool-output-wrapper";

function storeWith(text: string, overrides: Partial<ToolArtifactMetadata> = {}): ToolArtifactStoreLike {
  const metadata: ToolArtifactMetadata = {
    id: "artifact-1",
    label: "Team Docs: Jira search",
    sourceToolName: "mcp__team_docs__call_readonly_tool",
    contentType: "text/plain",
    createdAt: "2026-06-24T00:00:00.000Z",
    charLength: text.length,
    ...overrides,
  };
  return {
    async writeArtifact() {
      return metadata;
    },
    async readArtifact(id: string) {
      if (id !== metadata.id) throw new Error("not found");
      return { metadata, text };
    },
    async listArtifacts() {
      return [metadata];
    },
  };
}

function artifactTool(store: ToolArtifactStoreLike) {
  const tool = createArtifactTool(store);
  if (!tool) throw new Error("artifact tool missing");
  return tool;
}

describe("artifact tool", () => {
  it("is absent without an artifact store", () => {
    expect(createArtifactTool(undefined)).toBeUndefined();
  });

  it("declares action as a schema enum and rejects a missing id", async () => {
    const tool = artifactTool(storeWith("text"));
    const action = (tool.parameters as unknown as { properties: Record<string, { enum?: string[] }> }).properties.action;
    expect(action.enum).toEqual(["list", "search", "read", "export"]);
    await expect(tool.execute("call-1", { action: "read" })).rejects.toThrow('id is required for action "read"');
  });

  it("read returns a bounded chunk with next-offset guidance", async () => {
    const tool = artifactTool(storeWith("0123456789abcdef", { sourceKind: "web", sourceTextHash: "hash-1" }));

    const result = await tool.execute("call-1", { action: "read", id: "artifact-1", offset: 4, limit: 5 });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Artifact artifact-1");
    expect(text).toContain("Source kind: web");
    expect(text).toContain("Source text hash: hash-1");
    expect(text).toContain("Characters 4-8 of 16 (truncated)");
    expect(text).toContain("45678");
    expect(text).toContain("offset 9");
    expect(result.details).toMatchObject({ artifactId: "artifact-1", offset: 4, returnedChars: 5 });
  });

  it("search returns offsets and snippets", async () => {
    const tool = artifactTool(storeWith("alpha\nbeta one\nbeta two\nomega"));

    const result = await tool.execute("call-1", { action: "search", id: "artifact-1", query: "beta", maxMatches: 2 });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Query: beta");
    expect(text).toContain("offset 6, line 2");
    expect(text).toContain("offset 15, line 3");
    expect(result.details).toMatchObject({ artifactId: "artifact-1", query: "beta", matches: 2 });
  });

  it("list returns recent artifact metadata", async () => {
    const tool = artifactTool(storeWith("source body", { sourceKind: "pdf" }));

    const result = await tool.execute("call-1", { action: "list", sourceKind: "pdf" });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain('Artifacts matching source kind "pdf"');
    expect(text).toContain("artifact-1 | Team Docs: Jira search | kind=pdf");
    expect(result.details).toMatchObject({ count: 1, sourceKind: "pdf" });
  });

  it("export returns a bounded read-only payload", async () => {
    const tool = artifactTool(storeWith("0123456789abcdef", { sourceKind: "docx" }));

    const result = await tool.execute("call-1", { action: "export", id: "artifact-1", format: "json", limit: 8 });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const parsed = JSON.parse(unwrapToolOutput(text)) as { metadata: ToolArtifactMetadata; text: string; truncated: boolean };
    expect(parsed.metadata).toMatchObject({ id: "artifact-1", sourceKind: "docx" });
    expect(parsed.text).toBe("01234567");
    expect(parsed.truncated).toBe(true);
    expect(result.details).toMatchObject({ artifactId: "artifact-1", format: "json", returnedChars: 8, truncated: true });
  });
});
