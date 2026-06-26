import { describe, expect, it } from "vitest";
import { McpHttpClient, normalizeMcpUrl } from "../src/mcp/client";
import { createMcpServerSettings, type McpServerSettings } from "../src/mcp/settings";
import type { WebFetcher, WebHttpRequest, WebHttpResponse } from "../src/tools/web-fetch";

function response(result: unknown, headers: Record<string, string> = {}): WebHttpResponse {
  return {
    status: 200,
    text: JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
    headers,
  };
}

function jsonRpc(id: number, result: unknown, headers: Record<string, string> = {}): WebHttpResponse {
  return {
    status: 200,
    text: JSON.stringify({ jsonrpc: "2.0", id, result }),
    headers,
  };
}

function jsonRpcError(id: number, code: number, message: string): WebHttpResponse {
  return {
    status: 200,
    text: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    headers: {},
  };
}

function queuedFetcher(
  responses: WebHttpResponse[],
  onRequest?: (request: WebHttpRequest) => void,
): WebFetcher {
  return async (request) => {
    onRequest?.(request);
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
}

function server(overrides: Partial<McpServerSettings> = {}): McpServerSettings {
  return {
    ...createMcpServerSettings({
      id: "docs",
      name: "Docs MCP",
      url: "https://mcp.example.com/mcp",
      authType: "header",
      authHeaderName: "X-API-Key",
    }),
    authHeaderValue: "secret",
    ...overrides,
  };
}

function oauthServer(overrides: Partial<McpServerSettings> = {}): McpServerSettings {
  return createMcpServerSettings({
    id: "oauth_mcp",
    name: "OAuth MCP",
    url: "https://oauth-mcp.example.com/mcp",
    authType: "oauth",
    ...overrides,
  });
}

describe("McpHttpClient", () => {
  it("initializes, sends the initialized notification, and lists tools with session headers", async () => {
    const requests: WebHttpRequest[] = [];
    const fetcher = queuedFetcher(
      [
        response({ protocolVersion: "2025-11-25", serverInfo: { name: "ctx" } }, { "mcp-session-id": "s1" }),
        { status: 202, text: "", headers: {} },
        {
          status: 200,
          text: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: {
              tools: [
                {
                  name: "resolve-library-id",
                  description: "Resolve a package.",
                  inputSchema: { type: "object", properties: { libraryName: { type: "string" } } },
                },
              ],
            },
          }),
          headers: {},
        },
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({ server: server(), fetcher });
    const tools = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["resolve-library-id"]);
    expect(requests).toHaveLength(3);
    expect(requests[0].url).toBe("https://mcp.example.com/mcp");
    expect(requests[0].headers).toMatchObject({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
      "X-API-Key": "secret",
    });
    expect(JSON.parse(requests[0].body ?? "{}")).toMatchObject({ method: "initialize" });
    expect(JSON.parse(requests[1].body ?? "{}")).toMatchObject({ method: "notifications/initialized" });
    expect(requests[2].headers).toMatchObject({ "MCP-Session-Id": "s1" });
    expect(JSON.parse(requests[2].body ?? "{}")).toMatchObject({ id: 2, method: "tools/list" });
  });

  it("calls a remote tool through tools/call", async () => {
    const requests: WebHttpRequest[] = [];
    const fetcher = queuedFetcher(
      [
        response({ protocolVersion: "2025-11-25" }),
        { status: 202, text: "", headers: {} },
        {
          status: 200,
          text: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: "done" }] },
          }),
          headers: {},
        },
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({ server: server(), fetcher });
    const result = await client.callTool("resolve-library-id", { libraryName: "obsidian" });

    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(JSON.parse(requests[2].body ?? "{}")).toMatchObject({
      method: "tools/call",
      params: { name: "resolve-library-id", arguments: { libraryName: "obsidian" } },
    });
  });

  it("sends static bearer tokens without requiring a custom header name", async () => {
    const requests: WebHttpRequest[] = [];
    const fetcher = queuedFetcher(
      [
        response({ protocolVersion: "2025-11-25" }),
        { status: 202, text: "", headers: {} },
        {
          status: 200,
          text: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
          headers: {},
        },
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({
      server: server({ authType: "bearer", authHeaderName: "", authHeaderValue: "static-token" }),
      fetcher,
    });
    await client.listTools();

    expect(requests.map((request) => request.headers?.Authorization)).toEqual([
      "Bearer static-token",
      "Bearer static-token",
      "Bearer static-token",
    ]);
    expect(requests.some((request) => request.headers?.["X-API-Key"])).toBe(false);
  });

  it("does not send stale static credentials when auth is disabled", async () => {
    const requests: WebHttpRequest[] = [];
    const fetcher = queuedFetcher(
      [
        response({ protocolVersion: "2025-11-25" }),
        { status: 202, text: "", headers: {} },
        {
          status: 200,
          text: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
          headers: {},
        },
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({
      server: server({ authType: "none", authHeaderName: "X-API-Key", authHeaderValue: "stale-token" }),
      fetcher,
    });
    await client.listTools();

    expect(requests.some((request) => request.headers?.Authorization)).toBe(false);
    expect(requests.some((request) => request.headers?.["X-API-Key"])).toBe(false);
  });

  it("rejects invalid custom auth headers before sending a request", async () => {
    const requests: WebHttpRequest[] = [];
    const client = new McpHttpClient({
      server: server({ authHeaderName: "X-API-Key\r\nInjected", authHeaderValue: "secret" }),
      fetcher: queuedFetcher([], (request) => requests.push(request)),
    });

    await expect(client.listTools()).rejects.toThrow(/header names/i);
    expect(requests).toEqual([]);
  });

  it("rejects auth header values containing raw line breaks", async () => {
    const requests: WebHttpRequest[] = [];
    const client = new McpHttpClient({
      server: server({ authHeaderName: "X-API-Key", authHeaderValue: "secret\r\nInjected: yes" }),
      fetcher: queuedFetcher([], (request) => requests.push(request)),
    });

    await expect(client.listTools()).rejects.toThrow(/line breaks/i);
    expect(requests).toEqual([]);
  });

  it("parses CRLF-delimited SSE JSON-RPC responses", async () => {
    const fetcher = queuedFetcher([
      {
        status: 200,
        text: 'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25"}}\r\n\r\n',
        headers: { "content-type": "text/event-stream" },
      },
      { status: 202, text: "", headers: {} },
      {
        status: 200,
        text:
          'event: keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/ping"}\r\n\r\n' +
          'event: message\r\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_time"}]}}\r\n\r\n',
        headers: { "content-type": "text/event-stream" },
      },
    ]);

    const client = new McpHttpClient({ server: server(), fetcher });

    await expect(client.listTools()).resolves.toMatchObject([{ name: "get_time" }]);
  });

  it("falls back to an older MCP protocol version when initialize rejects the current version", async () => {
    const requests: WebHttpRequest[] = [];
    const fetcher = queuedFetcher(
      [
        jsonRpcError(1, -32602, "Unsupported protocol version: 2025-11-25"),
        jsonRpc(2, { protocolVersion: "2025-06-18" }),
        { status: 202, text: "", headers: {} },
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({ server: server(), fetcher });

    await expect(client.initialize()).resolves.toMatchObject({ protocolVersion: "2025-06-18" });
    expect(JSON.parse(requests[0].body ?? "{}").params.protocolVersion).toBe("2025-11-25");
    expect(JSON.parse(requests[1].body ?? "{}").params.protocolVersion).toBe("2025-06-18");
    expect(requests[2].headers).toMatchObject({ "MCP-Protocol-Version": "2025-06-18" });
  });

  it("opens the standalone SSE stream when a request is accepted asynchronously", async () => {
    const requests: WebHttpRequest[] = [];
    const fetcher = queuedFetcher(
      [
        response({ protocolVersion: "2025-11-25" }, { "mcp-session-id": "s1" }),
        { status: 202, text: "", headers: {} },
        { status: 202, text: "", headers: {} },
        {
          status: 200,
          text: 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"async_tool"}]}}\n\n',
          headers: { "content-type": "text/event-stream" },
        },
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({ server: server(), fetcher });

    await expect(client.listTools()).resolves.toMatchObject([{ name: "async_tool" }]);
    expect(requests[3]).toMatchObject({
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "MCP-Session-Id": "s1",
      },
    });
    expect(requests[3].headers).not.toHaveProperty("Last-Event-ID");
  });

  it("resumes an incomplete SSE response with Last-Event-ID", async () => {
    const requests: WebHttpRequest[] = [];
    const fetcher = queuedFetcher(
      [
        response({ protocolVersion: "2025-11-25" }, { "mcp-session-id": "s1" }),
        { status: 202, text: "", headers: {} },
        {
          status: 200,
          text:
            "id: stream-1\n" +
            "data:\n\n" +
            "event: message\n" +
            "id: stream-2\n" +
            'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
          headers: { "content-type": "text/event-stream" },
        },
        {
          status: 200,
          text:
            "event: message\n" +
            "id: stream-3\n" +
            'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_time"}]}}\n\n',
          headers: { "content-type": "text/event-stream" },
        },
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({ server: server(), fetcher });

    await expect(client.listTools()).resolves.toMatchObject([{ name: "get_time" }]);
    expect(requests[3]).toMatchObject({
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Last-Event-ID": "stream-2",
        "MCP-Session-Id": "s1",
      },
    });
  });

  it("makes multiple Last-Event-ID resume attempts when SSE redelivery is incremental", async () => {
    const requests: WebHttpRequest[] = [];
    const fetcher = queuedFetcher(
      [
        response({ protocolVersion: "2025-11-25" }, { "mcp-session-id": "s1" }),
        { status: 202, text: "", headers: {} },
        {
          status: 200,
          text: 'event: message\nid: stream-1\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
          headers: { "content-type": "text/event-stream" },
        },
        {
          status: 200,
          text: 'event: message\nid: stream-2\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
          headers: { "content-type": "text/event-stream" },
        },
        {
          status: 200,
          text: 'event: message\nid: stream-3\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_time"}]}}\n\n',
          headers: { "content-type": "text/event-stream" },
        },
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({ server: server(), fetcher });

    await expect(client.listTools()).resolves.toMatchObject([{ name: "get_time" }]);
    expect(requests[3].headers).toMatchObject({ "Last-Event-ID": "stream-1" });
    expect(requests[4].headers).toMatchObject({ "Last-Event-ID": "stream-2" });
  });

  it("rejects non-HTTPS endpoints before network access", async () => {
    const fetcher: WebFetcher = async () => {
      throw new Error("should not fetch");
    };
    const client = new McpHttpClient({
      server: server({ url: "http://mcp.example.com/mcp" }),
      fetcher,
    });

    await expect(client.listTools()).rejects.toThrow(/must use https/i);
    expect(() => normalizeMcpUrl("http://mcp.example.com/mcp")).toThrow(/must use https/i);
  });

  it("sends OAuth bearer tokens for authenticated MCP servers", async () => {
    const requests: WebHttpRequest[] = [];
    const mcpServer = oauthServer();
    mcpServer.oauth.accessToken = "access-token";
    const fetcher = queuedFetcher(
      [
        response({ protocolVersion: "2025-11-25" }),
        { status: 202, text: "", headers: {} },
        {
          status: 200,
          text: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
          headers: {},
        },
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({ server: mcpServer, fetcher });
    await client.listTools();

    expect(requests[0].headers).toMatchObject({ Authorization: "Bearer access-token" });
    expect(requests[1].headers).toMatchObject({ Authorization: "Bearer access-token" });
    expect(requests[2].headers).toMatchObject({ Authorization: "Bearer access-token" });
  });

  it("refreshes and retries once when an OAuth token is rejected at runtime", async () => {
    const requests: WebHttpRequest[] = [];
    let saved = 0;
    const mcpServer = oauthServer();
    mcpServer.oauth = {
      ...mcpServer.oauth,
      clientId: "client-1",
      accessToken: "old-access",
      refreshToken: "refresh-1",
      tokenEndpoint: "https://auth.example.com/token",
      expiresAt: 9_999_999_999_999,
    };
    const fetcher = queuedFetcher(
      [
        {
          status: 401,
          text: "",
          headers: { "www-authenticate": 'Bearer error="invalid_token", error_description="expired"' },
        },
        {
          status: 200,
          text: JSON.stringify({ access_token: "new-access", refresh_token: "refresh-2", expires_in: 3600 }),
          headers: {},
        },
        response({ protocolVersion: "2025-11-25" }, { "mcp-session-id": "s2" }),
        { status: 202, text: "", headers: {} },
        {
          status: 200,
          text: JSON.stringify({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "search" }] } }),
          headers: {},
        },
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({
      server: mcpServer,
      fetcher,
      onServerChanged: () => {
        saved += 1;
      },
    });

    await expect(client.listTools()).resolves.toMatchObject([{ name: "search" }]);

    expect(saved).toBe(1);
    expect(mcpServer.oauth.accessToken).toBe("new-access");
    expect(mcpServer.oauth.refreshToken).toBe("refresh-2");
    const refreshBody = new URLSearchParams(requests[1].body ?? "");
    expect(requests[1].url).toBe("https://auth.example.com/token");
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("refresh-1");
    expect(refreshBody.get("resource")).toBe("https://oauth-mcp.example.com/mcp");
    expect(requests.map((request) => request.headers?.Authorization).filter(Boolean)).toEqual([
      "Bearer old-access",
      "Bearer new-access",
      "Bearer new-access",
      "Bearer new-access",
    ]);
    expect(requests.filter((request) => request.url === mcpServer.url).map((request) => {
      const body = JSON.parse(request.body ?? "{}") as { method?: string };
      return body.method;
    })).toEqual(["initialize", "initialize", "notifications/initialized", "tools/list"]);
  });

  it("prompts for OAuth authentication when a 401 cannot be refreshed", async () => {
    const mcpServer = oauthServer();
    const fetcher = queuedFetcher([
      {
        status: 401,
        text: "",
        headers: {
          "www-authenticate":
            'Bearer error="invalid_request", error_description="Authorization header is required"',
        },
      },
    ]);

    const client = new McpHttpClient({ server: mcpServer, fetcher });

    await expect(client.listTools()).rejects.toThrow(
      /requires OAuth authentication.*Authorization header is required/i,
    );
  });

  it("includes advertised OAuth scopes when a token is forbidden", async () => {
    const mcpServer = oauthServer();
    mcpServer.oauth.accessToken = "access-token";
    const fetcher = queuedFetcher([
      {
        status: 403,
        text: "",
        headers: {
          "www-authenticate":
            'Bearer error="insufficient_scope", scope="openid profile email"',
        },
      },
    ]);

    const client = new McpHttpClient({ server: mcpServer, fetcher });

    await expect(client.listTools()).rejects.toThrow(
      /refused the OAuth token.*Required OAuth scopes: openid profile email/i,
    );
  });

  it("refreshes with required scopes and retries once when OAuth reports insufficient scope", async () => {
    const requests: WebHttpRequest[] = [];
    let saved = 0;
    const mcpServer = oauthServer();
    mcpServer.oauth = {
      ...mcpServer.oauth,
      clientId: "client-1",
      accessToken: "old-access",
      refreshToken: "refresh-1",
      tokenEndpoint: "https://auth.example.com/token",
      expiresAt: 9_999_999_999_999,
      scope: "openid profile",
    };
    const fetcher = queuedFetcher(
      [
        {
          status: 403,
          text: "",
          headers: {
            "www-authenticate": 'Bearer error="insufficient_scope", scope="openid profile email"',
          },
        },
        {
          status: 200,
          text: JSON.stringify({
            access_token: "new-access",
            refresh_token: "refresh-2",
            expires_in: 3600,
            scope: "openid profile email",
          }),
          headers: {},
        },
        jsonRpc(2, { protocolVersion: "2025-11-25" }, { "mcp-session-id": "s2" }),
        { status: 202, text: "", headers: {} },
        jsonRpc(3, { tools: [{ name: "scoped_search" }] }),
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({
      server: mcpServer,
      fetcher,
      onServerChanged: () => {
        saved += 1;
      },
    });

    await expect(client.listTools()).resolves.toMatchObject([{ name: "scoped_search" }]);

    const refreshBody = new URLSearchParams(requests[1].body ?? "");
    expect(refreshBody.get("scope")).toBe("openid profile email");
    expect(mcpServer.oauth.scope).toBe("openid profile email");
    expect(saved).toBe(1);
    expect(requests.map((request) => request.headers?.Authorization).filter(Boolean)).toEqual([
      "Bearer old-access",
      "Bearer new-access",
      "Bearer new-access",
      "Bearer new-access",
    ]);
  });

  it("reopens a Streamable HTTP session once when the server terminates it", async () => {
    const requests: WebHttpRequest[] = [];
    const fetcher = queuedFetcher(
      [
        response({ protocolVersion: "2025-11-25" }, { "mcp-session-id": "s1" }),
        { status: 202, text: "", headers: {} },
        { status: 404, text: "session gone", headers: {} },
        {
          status: 200,
          text: JSON.stringify({ jsonrpc: "2.0", id: 3, result: { protocolVersion: "2025-11-25" } }),
          headers: { "mcp-session-id": "s2" },
        },
        { status: 202, text: "", headers: {} },
        {
          status: 200,
          text: JSON.stringify({ jsonrpc: "2.0", id: 4, result: { tools: [{ name: "get_time" }] } }),
          headers: {},
        },
      ],
      (request) => requests.push(request),
    );

    const client = new McpHttpClient({ server: server(), fetcher });
    await expect(client.listTools()).resolves.toMatchObject([{ name: "get_time" }]);

    expect(requests.map((request) => JSON.parse(request.body ?? "{}").method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(requests[2].headers).toMatchObject({ "MCP-Session-Id": "s1" });
    expect(requests[5].headers).toMatchObject({ "MCP-Session-Id": "s2" });
  });

  it("times out MCP HTTP requests with an actionable error", async () => {
    const fetcher: WebFetcher = async () => new Promise<WebHttpResponse>(() => undefined);
    const client = new McpHttpClient({ server: server(), fetcher, requestTimeoutMs: 1 });

    await expect(client.listTools()).rejects.toThrow(/timed out.*Docs MCP initialize/i);
  });
});
