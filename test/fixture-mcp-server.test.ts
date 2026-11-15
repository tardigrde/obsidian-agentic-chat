import { afterEach, describe, expect, it } from "vitest";
import { McpHttpClient } from "../src/mcp/client";
import { createMcpServerSettings } from "../src/mcp/settings";
import type { WebFetcher } from "../src/tools/web-fetch";
import { startFixtureMcpServer, type FixtureMcpServer } from "../scripts/eval/fixture-mcp-server";

const servers: FixtureMcpServer[] = [];
let nextId = 1;

async function start(options?: { port?: number; toolCount?: number }): Promise<FixtureMcpServer> {
  const server = await startFixtureMcpServer(options);
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface JsonRpcBody {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    protocolVersion?: string;
    capabilities?: { tools?: unknown };
    serverInfo?: { name?: string; version?: string };
    tools?: Array<{
      name?: string;
      description?: string;
      inputSchema?: { type?: string; properties?: Record<string, unknown> };
      annotations?: { readOnlyHint?: boolean };
    }>;
    content?: Array<{ type?: string; text?: string }>;
  };
  error?: { code?: number; message?: string };
}

async function rpc(
  server: FixtureMcpServer,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ response: Response; body: JsonRpcBody }> {
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? (JSON.parse(text) as JsonRpcBody) : {} };
}

async function initialize(server: FixtureMcpServer): Promise<{
  response: Response;
  body: JsonRpcBody;
  id: number;
  sessionId: string | null;
}> {
  const id = nextId;
  nextId += 1;
  const { response, body } = await rpc(server, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "fixture-test", version: "0.0.0" },
    },
  });
  return { response, body, id, sessionId: response.headers.get("mcp-session-id") };
}

async function listTools(server: FixtureMcpServer): Promise<JsonRpcBody["result"]> {
  const { body } = await rpc(server, { jsonrpc: "2.0", id: nextId++, method: "tools/list" });
  return body.result;
}

function toolNames(result: JsonRpcBody["result"]): string[] {
  return (result?.tools ?? []).map((tool) => tool.name ?? "");
}

describe("fake MCP server", () => {
  it("answers initialize with a protocol version, a tools capability, server info, and a session id", async () => {
    const server = await start();
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`);
    const { response, body, id, sessionId } = await initialize(server);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(sessionId).toBeTruthy();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(id);
    expect(body.result?.protocolVersion).toBe("2025-11-25");
    expect(body.result?.capabilities?.tools).toEqual(expect.any(Object));
    expect(body.result?.serverInfo?.name).toEqual(expect.any(String));
    expect(body.result?.serverInfo?.version).toEqual(expect.any(String));
  });

  it("accepts notifications/initialized with 202 and no body", async () => {
    const server = await start();
    const { response, body } = await rpc(server, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.status).toBe(202);
    expect(body).toEqual({});
  });

  it("answers ping with an empty result", async () => {
    const server = await start();
    const { response, body } = await rpc(server, { jsonrpc: "2.0", id: 3, method: "ping" });
    expect(response.status).toBe(200);
    expect(body.result).toEqual({});
  });

  it("lists 30 unique tools with one-line descriptions and object schemas", async () => {
    const server = await start();
    const result = await listTools(server);
    const tools = result?.tools ?? [];
    expect(tools).toHaveLength(30);
    const names = toolNames(result);
    expect(new Set(names).size).toBe(30);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description?.trim()).toBeTruthy();
      expect(tool.description).not.toContain("\n");
      expect(tool.inputSchema?.type).toBe("object");
      expect(tool.inputSchema?.properties).toEqual(expect.any(Object));
    }
  });

  it("covers search, docs, tickets, calendar, files, and admin tools", async () => {
    const server = await start();
    const names = toolNames(await listTools(server));
    for (const representative of [
      "search_documents",
      "get_document",
      "get_ticket",
      "list_calendar_events",
      "read_file",
      "list_users",
    ]) {
      expect(names).toContain(representative);
    }
  });

  it("returns a deterministic tools/call result and echoes the JSON-RPC id", async () => {
    const server = await start();
    const params = {
      name: "search_documents",
      arguments: { query: "release checklist" },
    };
    const first = await rpc(server, { jsonrpc: "2.0", id: 11, method: "tools/call", params });
    const second = await rpc(server, { jsonrpc: "2.0", id: 12, method: "tools/call", params });
    expect(first.response.status).toBe(200);
    expect(first.body.id).toBe(11);
    expect(first.body.result?.content?.[0]?.type).toBe("text");
    expect(first.body.result?.content?.[0]?.text).toContain("release checklist");
    expect(second.body.result).toEqual(first.body.result);
  });

  it("answers a known tool with its fixed record", async () => {
    const server = await start();
    const { body } = await rpc(server, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "get_ticket", arguments: { id: "T-42" } },
    });
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).toContain("T-42");
    expect(text).toContain("open");
  });

  it("answers an unknown tool with a JSON-RPC -32602 error", async () => {
    const server = await start();
    const { response, body } = await rpc(server, {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    });
    expect(response.status).toBe(200);
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain("Unknown tool");
    expect(body.id).toBe(14);
  });

  it("accepts the session id from initialize on later requests", async () => {
    const server = await start();
    const { sessionId } = await initialize(server);
    const { response, body } = await rpc(
      server,
      { jsonrpc: "2.0", id: nextId++, method: "tools/list" },
      { "mcp-session-id": sessionId ?? "" },
    );
    expect(response.status).toBe(200);
    expect(body.result?.tools).toHaveLength(30);
  });

  it("answers GET /mcp with 405 because it only answers JSON over POST", async () => {
    const server = await start();
    const response = await fetch(server.url, { headers: { accept: "text/event-stream" } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("answers malformed JSON with 400 and keeps serving", async () => {
    const server = await start();
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    const { response: ping, body } = await rpc(server, { jsonrpc: "2.0", id: 15, method: "ping" });
    expect(ping.status).toBe(200);
    expect(body.result).toEqual({});
  });

  it("honors toolCount and keeps generated names unique", async () => {
    const small = await start({ toolCount: 3 });
    expect(toolNames(await listTools(small))).toHaveLength(3);
    const large = await start({ toolCount: 35 });
    const names = toolNames(await listTools(large));
    expect(names).toHaveLength(35);
    expect(new Set(names).size).toBe(35);
  });

  it("runs two servers at once on different ports", async () => {
    const first = await start();
    const second = await start();
    expect(first.port).not.toBe(second.port);
    const [a, b] = await Promise.all([initialize(first), initialize(second)]);
    expect(a.body.result?.protocolVersion).toBe("2025-11-25");
    expect(b.body.result?.protocolVersion).toBe("2025-11-25");
  });

  it("is idempotent on close and stops listening", async () => {
    const server = await start();
    expect((await initialize(server)).response.status).toBe(200);
    await server.close();
    await server.close();
    await expect(fetch(server.url, { method: "POST", body: "{}" })).rejects.toThrow();
  });

  it("works with the product McpHttpClient", async () => {
    const server = await start();
    const fetcher: WebFetcher = async (request, signal) => {
      const response = await fetch(request.url, {
        method: request.method ?? "GET",
        headers: request.headers,
        body: request.body,
        signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      return { status: response.status, text: await response.text(), headers };
    };
    const client = new McpHttpClient({
      server: createMcpServerSettings({
        id: "fixture",
        name: "Fixture MCP",
        url: server.url,
      }),
      fetcher,
    });
    const initialized = await client.initialize();
    expect(initialized.protocolVersion).toBe("2025-11-25");
    const tools = await client.listTools();
    expect(tools).toHaveLength(30);
    expect(tools.map((tool) => tool.name)).toContain("get_document");
    const result = await client.callTool("get_ticket", { id: "T-42" });
    expect(result.isError).toBeUndefined();
    expect(result.content?.[0]).toMatchObject({ type: "text" });
    expect((result.content?.[0] as { text: string }).text).toContain("T-42");
    await expect(client.callTool("unknown_tool", {})).rejects.toThrow("Unknown tool");
  });
});
