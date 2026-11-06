import { describe, expect, it } from "vitest";
import { McpHttpClient } from "../src/mcp/client";
import { createMcpServerSettings } from "../src/mcp/settings";
import type { WebFetcher, WebHttpRequest, WebHttpResponse } from "../src/tools/web-fetch";

function jsonRpc(id: number, result: unknown, headers: Record<string, string> = {}): WebHttpResponse {
  return {
    status: 200,
    text: JSON.stringify({ jsonrpc: "2.0", id, result }),
    headers,
  };
}

describe("post-216 MCP handshake recovery", () => {
  it("drops a dead session id when the initialized notification fails", async () => {
    const requests: WebHttpRequest[] = [];
    let notifyAttempts = 0;
    const fetcher: WebFetcher = async (request) => {
      requests.push(request);
      const body = JSON.parse(request.body ?? "{}") as { id?: number; method?: string };
      if (body.method === "initialize") {
        return jsonRpc(body.id ?? 0, { protocolVersion: "2025-11-25" }, { "mcp-session-id": "dead-session" });
      }
      if (body.method === "notifications/initialized") {
        notifyAttempts += 1;
        if (notifyAttempts === 1) throw new Error("initialized notification failed");
        return { status: 202, text: "", headers: {} };
      }
      if (body.method === "tools/list") return jsonRpc(body.id ?? 0, { tools: [] });
      throw new Error(`unexpected method ${body.method}`);
    };
    const client = new McpHttpClient({
      server: createMcpServerSettings({
        id: "docs",
        name: "Docs MCP",
        url: "https://mcp.example.com/mcp",
        authType: "none",
      }),
      fetcher,
    });

    await expect(client.listTools()).rejects.toThrow("initialized notification failed");
    await expect(client.listTools()).resolves.toEqual([]);

    const initializeRequests = requests.filter(
      (request) => JSON.parse(request.body ?? "{}").method === "initialize",
    );
    expect(initializeRequests).toHaveLength(2);
    expect(initializeRequests[1]?.headers?.["MCP-Session-Id"]).toBeUndefined();
  });
});
