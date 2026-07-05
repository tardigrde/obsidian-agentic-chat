import { describe, expect, it } from "vitest";
import { createToolArtifactTools } from "../src/artifacts/tool-artifact-tools";
import type { ToolArtifactMetadata, ToolArtifactStoreLike } from "../src/artifacts/tool-artifact-store";

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

describe("tool artifact tools", () => {
  it("read_artifact returns a bounded chunk with next-offset guidance", async () => {
    const tools = createToolArtifactTools(storeWith("0123456789abcdef", { sourceKind: "web", sourceTextHash: "hash-1" }));
    const read = tools.find((tool) => tool.name === "read_artifact");

    const result = await read?.execute("call-1", { id: "artifact-1", offset: 4, limit: 5 });

    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Artifact artifact-1");
    expect(text).toContain("Source kind: web");
    expect(text).toContain("Source text hash: hash-1");
    expect(text).toContain("Characters 4-8 of 16 (truncated)");
    expect(text).toContain("45678");
    expect(text).toContain("offset 9");
    expect(result?.details).toMatchObject({ artifactId: "artifact-1", offset: 4, returnedChars: 5 });
  });

  it("search_artifact returns offsets and snippets", async () => {
    const tools = createToolArtifactTools(storeWith("alpha\nbeta one\nbeta two\nomega"));
    const search = tools.find((tool) => tool.name === "search_artifact");

    const result = await search?.execute("call-1", { id: "artifact-1", query: "beta", maxMatches: 2 });

    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Query: beta");
    expect(text).toContain("offset 6, line 2");
    expect(text).toContain("offset 15, line 3");
    expect(result?.details).toMatchObject({ artifactId: "artifact-1", query: "beta", matches: 2 });
  });

  it("list_artifacts returns recent artifact metadata", async () => {
    const tools = createToolArtifactTools(storeWith("source body", { sourceKind: "pdf" }));
    const list = tools.find((tool) => tool.name === "list_artifacts");

    const result = await list?.execute("call-1", { sourceKind: "pdf" });

    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain('Artifacts matching source kind "pdf"');
    expect(text).toContain("artifact-1 | Team Docs: Jira search | kind=pdf");
    expect(result?.details).toMatchObject({ count: 1, sourceKind: "pdf" });
  });

  it("export_artifact returns a bounded read-only payload", async () => {
    const tools = createToolArtifactTools(storeWith("0123456789abcdef", { sourceKind: "docx" }));
    const exportTool = tools.find((tool) => tool.name === "export_artifact");

    const result = await exportTool?.execute("call-1", { id: "artifact-1", format: "json", limit: 8 });

    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
    const parsed = JSON.parse(text) as { metadata: ToolArtifactMetadata; text: string; truncated: boolean };
    expect(parsed.metadata).toMatchObject({ id: "artifact-1", sourceKind: "docx" });
    expect(parsed.text).toBe("01234567");
    expect(parsed.truncated).toBe(true);
    expect(result?.details).toMatchObject({ artifactId: "artifact-1", format: "json", returnedChars: 8, truncated: true });
  });
});
