import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  LoadedToolSet,
  createSearchToolsTool,
  formatDeferredToolsOverlay,
  isDeferredToolName,
  partitionTools,
  rankTools,
  tokenize,
} from "../src/agent/tool-loading";
import type { McpServerDiagnostic } from "../src/mcp/tools";
import { fixtureMcpTools } from "../scripts/eval/fixture-mcp-server";

const SERVER = "fixture";

/** The fake MCP server's 30 tools, named as the plugin exposes them. */
function mcpCatalog(): AgentTool[] {
  return fixtureMcpTools().map(
    (tool) =>
      ({
        name: `mcp__${SERVER}__${tool.name}`,
        label: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async () => ({ content: [], details: {} }),
      }) as unknown as AgentTool,
  );
}

function tool(name: string, description = ""): AgentTool {
  return { name, label: name, description, parameters: { type: "object", properties: {} } } as unknown as AgentTool;
}

function serverDiagnostic(toolNames: string[]): McpServerDiagnostic {
  return {
    serverId: SERVER,
    serverName: "Fixture Workspace",
    url: "http://localhost/mcp",
    authType: "none",
    approval: "ask",
    checkedAt: "2026-11-16T00:00:00.000Z",
    status: "ok",
    toolCount: toolNames.length,
    toolNames,
  } as McpServerDiagnostic;
}

describe("isDeferredToolName", () => {
  it("defers MCP tools and the rare built-ins, and keeps the core set loaded", () => {
    for (const name of ["mcp__x__y", "create_skill", "import_document"]) {
      expect(isDeferredToolName(name), name).toBe(true);
    }
    for (const name of ["read", "vault_inspect", "set_properties", "web_search", "skill", "artifact", "search_tools", "current_time"]) {
      expect(isDeferredToolName(name), name).toBe(false);
    }
  });
});

describe("rankTools", () => {
  it("picks the right tool out of the 30 fake MCP tools for a task description", () => {
    const catalog = mcpCatalog();
    expect(catalog).toHaveLength(30);
    const clear: Array<[string, string]> = [
      ["update ticket status", "update_ticket_status"],
      ["move a file to another folder", "move_file"],
      ["who is user U-1", "get_user"],
      ["schedule a meeting", "find_free_slots"],
      ["read the workspace audit log", "list_audit_log"],
      ["export a document as pdf", "export_document"],
    ];
    for (const [query, expected] of clear) {
      expect(rankTools(catalog, query)[0]?.tool.name, query).toBe(`mcp__${SERVER}__${expected}`);
    }
  });

  it("keeps the right tool inside the loaded top five for a vague request", () => {
    const top = rankTools(mcpCatalog(), "change the status of a support ticket")
      .slice(0, 5)
      .map((match) => match.tool.name);
    expect(top).toContain(`mcp__${SERVER}__update_ticket_status`);
  });

  it("ranks an exact tool name first, with or without the MCP prefix", () => {
    const catalog = mcpCatalog();
    expect(rankTools(catalog, "get_ticket")[0]?.tool.name).toBe(`mcp__${SERVER}__get_ticket`);
    expect(rankTools(catalog, `mcp__${SERVER}__delete_file`)[0]?.tool.name).toBe(`mcp__${SERVER}__delete_file`);
  });

  it("returns nothing for a query with no matching word", () => {
    expect(rankTools(mcpCatalog(), "zzzz qqqq")).toEqual([]);
    expect(rankTools(mcpCatalog(), "   ")).toEqual([]);
  });

  it("tokenizes names, folds accents and plurals, and drops filler words", () => {
    expect(tokenize("mcp__docs__search_Documents")).toEqual(["doc", "search", "document"]);
    expect(tokenize("Átírás of the notes")).toEqual(["atira", "note"]);
  });
});

describe("LoadedToolSet", () => {
  it("reports whether an add changed the set", () => {
    const loaded = new LoadedToolSet();
    expect(loaded.add(["a", "b"])).toBe(true);
    expect(loaded.add(["b"])).toBe(false);
    expect(loaded.list()).toEqual(["a", "b"]);
  });

  it("restores from a transcript: search results and deferred tool results, nothing else", () => {
    const loaded = new LoadedToolSet();
    loaded.add(["stale"]);
    const messages = [
      { role: "user", content: "hi", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "1",
        toolName: "search_tools",
        content: [],
        details: { loaded: ["mcp__fixture__get_ticket", 7] },
        isError: false,
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: "2", toolName: "import_document", content: [], isError: true, timestamp: 3 },
      { role: "toolResult", toolCallId: "3", toolName: "read", content: [], isError: false, timestamp: 4 },
    ] as unknown as AgentMessage[];

    loaded.restoreFromMessages(messages);

    expect(loaded.list()).toEqual(["mcp__fixture__get_ticket", "import_document"]);
  });
});

describe("partitionTools", () => {
  it("sends core tools and loaded deferred tools, and keeps the rest deferred", () => {
    const loaded = new LoadedToolSet();
    loaded.add(["mcp__fixture__get_ticket"]);
    const { active, deferred } = partitionTools(
      [tool("read"), tool("import_document"), tool("mcp__fixture__get_ticket"), tool("mcp__fixture__get_user")],
      loaded,
    );
    expect(active.map((t) => t.name)).toEqual(["read", "mcp__fixture__get_ticket"]);
    expect(deferred.map((t) => t.name)).toEqual(["import_document", "mcp__fixture__get_user"]);
  });
});

describe("search_tools", () => {
  it("loads at most five matches and never a tool that is already loaded", async () => {
    const catalog = mcpCatalog();
    const loaded = new LoadedToolSet();
    loaded.add([`mcp__${SERVER}__search_tickets`]);
    const search = createSearchToolsTool({ getDeferredTools: () => catalog, loaded });

    const result = await search.execute("1", { query: "ticket" });

    const names = (result.details as { loaded: string[] }).loaded;
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThanOrEqual(5);
    expect(names).not.toContain(`mcp__${SERVER}__search_tickets`);
    for (const name of names) expect(loaded.has(name)).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Call them by name from your next step");
  });

  it("honors a smaller limit", async () => {
    const search = createSearchToolsTool({ getDeferredTools: () => mcpCatalog(), loaded: new LoadedToolSet() });
    const result = await search.execute("1", { query: "document", limit: 2 });
    expect((result.details as { loaded: string[] }).loaded).toHaveLength(2);
  });

  it("names the deferred tools when nothing matches", async () => {
    const search = createSearchToolsTool({
      getDeferredTools: () => [tool("import_document", "Extract document text.")],
      loaded: new LoadedToolSet(),
    });
    const result = await search.execute("1", { query: "zzzz" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Deferred tools: import_document");
    expect(result.details).toEqual({ query: "zzzz", loaded: [] });
  });
});

describe("formatDeferredToolsOverlay", () => {
  it("lists built-in deferred tools one per line and MCP tools one line per server", () => {
    const catalog = [tool("read", "Read a file."), tool("import_document", "Extract document text. More text."), ...mcpCatalog()];
    const overlay = formatDeferredToolsOverlay(
      catalog,
      [serverDiagnostic(fixtureMcpTools().map((t) => t.name))],
    );
    expect(overlay).toContain("## Deferred tools");
    expect(overlay).toContain("- import_document: Extract document text.");
    expect(overlay).toContain('- MCP server "Fixture Workspace": 30 tool(s)');
    expect(overlay).not.toContain("- read:");
    expect(overlay).not.toContain("search_documents");
  });

  it("maps remote names with the same sanitizing as the exposed tool names", () => {
    const overlay = formatDeferredToolsOverlay([tool("mcp__fixture__get_ticket_v2")], [serverDiagnostic(["get-ticket.v2"])]);
    expect(overlay).toContain('- MCP server "Fixture Workspace": 1 tool(s)');
    expect(overlay).not.toContain("Other MCP tools");
  });

  it("counts MCP tools without a server diagnostic on one line, and is empty with nothing deferred", () => {
    expect(formatDeferredToolsOverlay([tool("mcp__ghost__a"), tool("mcp__ghost__b")])).toContain("- Other MCP tools: 2");
    expect(formatDeferredToolsOverlay([tool("read")])).toBe("");
  });
});
