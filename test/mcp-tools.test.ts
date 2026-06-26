import { describe, expect, it } from "vitest";
import {
  createMcpTools,
  localMcpToolName,
  mcpServerIdFromToolName,
  probeMcpServer,
} from "../src/mcp/tools";
import { createMcpServerSettings, type McpSettings } from "../src/mcp/settings";
import type { ToolArtifactMetadata, ToolArtifactStoreLike, ToolArtifactWriteInput } from "../src/artifacts/tool-artifact-store";
import type { WebFetcher, WebHttpRequest, WebHttpResponse } from "../src/tools/web-fetch";

function mcpSettings(overrides: Partial<McpSettings> = {}): McpSettings {
  return {
    enabled: true,
    proxyUrl: "",
    noProxy: "localhost,127.0.0.1,::1",
    servers: [createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" })],
    ...overrides,
  };
}

function queuedFetcher(responses: WebHttpResponse[], requests: WebHttpRequest[] = []): WebFetcher {
  return async (request) => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
}

function rpc(id: number, result: unknown): WebHttpResponse {
  return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id, result }), headers: {} };
}

function memoryArtifactStore(): { store: ToolArtifactStoreLike; writes: ToolArtifactWriteInput[] } {
  const writes: ToolArtifactWriteInput[] = [];
  const artifacts = new Map<string, { metadata: ToolArtifactMetadata; text: string }>();
  return {
    writes,
    store: {
      async writeArtifact(input) {
        writes.push(input);
        const metadata: ToolArtifactMetadata = {
          id: `artifact-${writes.length}`,
          label: input.label,
          sourceToolName: input.sourceToolName,
          contentType: input.contentType ?? "text/plain",
          createdAt: "2026-06-24T00:00:00.000Z",
          charLength: input.text.length,
        };
        artifacts.set(metadata.id, { metadata, text: input.text });
        return metadata;
      },
      async readArtifact(id) {
        const artifact = artifacts.get(id);
        if (!artifact) throw new Error(`not found: ${id}`);
        return artifact;
      },
    },
  };
}

describe("MCP tools", () => {
  it("registers nothing while MCP is disabled", async () => {
    await expect(createMcpTools(mcpSettings({ enabled: false }), queuedFetcher([]))).resolves.toEqual([]);
  });

  it("discovers tools and maps local names safely", async () => {
    const tools = await createMcpTools(
      mcpSettings(),
      queuedFetcher([
        rpc(1, { protocolVersion: "2025-11-25" }),
        { status: 202, text: "", headers: {} },
        rpc(2, {
          tools: [
            {
              name: "resolve-library-id",
              title: "Resolve library",
              description: "Find a documentation library id.",
              inputSchema: {
                type: "object",
                properties: { libraryName: { type: "string" } },
                required: ["libraryName"],
              },
            },
          ],
        }),
      ]),
    );

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("mcp__docs__resolve_library_id");
    expect(tools[0].label).toBe("Docs MCP: Resolve library");
    expect(tools[0].description).toContain("Remote MCP tool");
    expect(localMcpToolName("Docs Server", "query-docs")).toBe("mcp__docs_server__query_docs");
    expect(mcpServerIdFromToolName("mcp__docs__resolve_library_id")).toBe("docs");
  });

  it("probes a server with the same initialize and list-tools path used for registration", async () => {
    const requests: WebHttpRequest[] = [];
    const result = await probeMcpServer(
      createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }),
      queuedFetcher(
        [
          rpc(1, { protocolVersion: "2025-11-25" }),
          { status: 202, text: "", headers: {} },
          rpc(2, {
            tools: [
              { name: "get_time", annotations: { readOnlyHint: true } },
              { name: "search_tools", title: "Search tools" },
            ],
          }),
        ],
        requests,
      ),
    );

    expect(result).toEqual({
      toolCount: 2,
      toolNames: ["get_time", "search_tools"],
      tools: [
        { name: "get_time", localName: "mcp__docs__get_time", title: "get_time", readOnlyHint: true },
        { name: "search_tools", localName: "mcp__docs__search_tools", title: "Search tools", readOnlyHint: false },
      ],
    });
    expect(requests.map((request) => JSON.parse(request.body ?? "{}").method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  it("lets connection probe errors surface to settings diagnostics", async () => {
    await expect(
      probeMcpServer(
        createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }),
        queuedFetcher([{ status: 500, text: "down", headers: {} }]),
      ),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("keeps sanitized remote tool names unique per server", async () => {
    const tools = await createMcpTools(
      mcpSettings(),
      queuedFetcher([
        rpc(1, { protocolVersion: "2025-11-25" }),
        { status: 202, text: "", headers: {} },
        rpc(2, {
          tools: [{ name: "resolve-library-id" }, { name: "resolve_library_id" }],
        }),
      ]),
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__docs__resolve_library_id",
      "mcp__docs__resolve_library_id_2",
    ]);
  });

  it("caches exact collision-suffixed local tool names during probes", async () => {
    const result = await probeMcpServer(
      createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }),
      queuedFetcher([
        rpc(1, { protocolVersion: "2025-11-25" }),
        { status: 202, text: "", headers: {} },
        rpc(2, {
          tools: [{ name: "resolve-library-id" }, { name: "resolve_library_id" }],
        }),
      ]),
    );

    expect(result.tools.map((tool) => tool.localName)).toEqual([
      "mcp__docs__resolve_library_id",
      "mcp__docs__resolve_library_id_2",
    ]);
  });

  it("calls the remote tool and truncates returned text", async () => {
    const requests: WebHttpRequest[] = [];
    const huge = "x".repeat(60_000);
    const tools = await createMcpTools(
      mcpSettings(),
      queuedFetcher(
        [
          rpc(1, { protocolVersion: "2025-11-25" }),
          { status: 202, text: "", headers: {} },
          rpc(2, {
            tools: [
              {
                name: "get-library-docs",
                inputSchema: {
                  type: "object",
                  properties: { libraryId: { type: "string" } },
                  required: ["libraryId"],
                },
              },
            ],
          }),
          rpc(1, { protocolVersion: "2025-11-25" }),
          { status: 202, text: "", headers: {} },
          rpc(2, { content: [{ type: "text", text: huge }] }),
        ],
        requests,
      ),
    );

    const result = await tools[0].execute("call-1", { libraryId: "/obsidianmd/obsidian" });

    expect(JSON.parse(requests[5].body ?? "{}")).toMatchObject({
      method: "tools/call",
      params: {
        name: "get-library-docs",
        arguments: { libraryId: "/obsidianmd/obsidian" },
      },
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.content[0].type === "text" ? result.content[0].text.length : 0).toBeLessThan(60_000);
    expect(result.details).toMatchObject({
      serverId: "docs",
      remoteToolName: "get-library-docs",
      truncated: true,
    });
  });

  it("materializes large MCP results as artifacts and keeps full structured content out of details", async () => {
    const artifacts = memoryArtifactStore();
    const body = JSON.stringify({ issues: Array.from({ length: 10 }, (_, index) => ({ key: `TEST-${index}` })) }, null, 2);
    const tools = await createMcpTools(
      mcpSettings(),
      queuedFetcher([
        rpc(1, { protocolVersion: "2025-11-25" }),
        { status: 202, text: "", headers: {} },
        rpc(2, { tools: [{ name: "jira_search", title: "Search issues" }] }),
        rpc(1, { protocolVersion: "2025-11-25" }),
        { status: 202, text: "", headers: {} },
        rpc(2, {
          content: [{ type: "text", text: body }],
          structuredContent: { result: body },
        }),
      ]),
      { artifactStore: artifacts.store, artifactThresholdChars: 100 },
    );

    const result = await tools[0].execute("call-1", { jql: "assignee = currentUser()" });

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain('MCP result stored as artifact "artifact-1"');
    expect(text).toContain("read_artifact");
    expect(artifacts.writes).toHaveLength(1);
    expect(artifacts.writes[0].text).toBe(body);
    expect(result.details).toMatchObject({
      artifactId: "artifact-1",
      artifactCharLength: body.length,
      structuredContentStored: true,
      truncated: true,
    });
    expect(result.details).not.toHaveProperty("structuredContent");
  });
});
