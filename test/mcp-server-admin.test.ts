import { describe, expect, it } from "vitest";
import { createMcpServerSettings, type McpServerSettings } from "../src/mcp/settings";
import { probeAndCache, type McpServerAdminDeps } from "../src/mcp/server-admin";
import type { WebFetcher, WebHttpRequest, WebHttpResponse } from "../src/tools/web-fetch";

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

function probeResponses(): WebHttpResponse[] {
  return [
    rpc(1, { protocolVersion: "2025-11-25" }),
    { status: 202, text: "", headers: {} },
    rpc(2, { tools: [{ name: "get_time", annotations: { readOnlyHint: true } }] }),
  ];
}

function deps(fetcher: WebFetcher): McpServerAdminDeps & { saved: number; synced: McpServerSettings[] } {
  const state = {
    saved: 0,
    synced: [] as McpServerSettings[],
    save: async () => {
      state.saved += 1;
    },
    sync: (server: McpServerSettings) => {
      state.synced.push(server);
    },
    fetcher,
  };
  return state;
}

describe("MCP server admin", () => {
  it("caches discovered tools, enables the server, and saves the synced state", async () => {
    const server = createMcpServerSettings({
      id: "docs",
      name: "Docs MCP",
      url: "https://mcp.example.com/mcp",
      enabled: false,
    });
    const admin = deps(queuedFetcher(probeResponses()));

    const result = await probeAndCache(server, admin);

    expect(result.toolCount).toBe(1);
    expect(result.toolNames).toEqual(["get_time"]);
    expect(server.knownTools).toEqual([
      { name: "get_time", localName: "mcp__docs__get_time", title: "get_time", readOnlyHint: true },
    ]);
    expect(server.enabled).toBe(true);
    expect(admin.synced).toContain(server);
    expect(admin.saved).toBe(1);
  });

  it("throws on an endpoint problem before any fetch or save", async () => {
    const server = createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "" });
    const requests: WebHttpRequest[] = [];
    const admin = deps(queuedFetcher(probeResponses(), requests));

    await expect(probeAndCache(server, admin)).rejects.toThrow(/Paste an HTTPS/i);

    expect(requests).toEqual([]);
    expect(admin.synced).toEqual([]);
    expect(admin.saved).toBe(0);
    expect(server.enabled).toBe(false);
    expect(server.knownTools).toEqual([]);
  });
});
