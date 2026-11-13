import { describe, expect, it } from "vitest";
import { McpHttpClient } from "../src/mcp/client";
import { McpError, type McpErrorCategory } from "../src/mcp/errors";
import { categorizeMcpDiagnosticError } from "../src/mcp/tools";
import { createMcpServerSettings } from "../src/mcp/settings";
import type { WebFetcher } from "../src/tools/web-fetch";

function oauthServer() {
  return createMcpServerSettings({
    id: "oauth_mcp",
    name: "OAuth MCP",
    url: "https://oauth-mcp.example.com/mcp",
    authType: "oauth",
  });
}

function challengeFetcher(status: number, header: string): WebFetcher {
  return async () => ({ status, text: "", headers: { "www-authenticate": header } });
}

describe("McpError", () => {
  it.each<[McpErrorCategory, string]>([
    ["auth", "MCP Docs requires OAuth authentication."],
    ["http", "MCP Docs request failed (HTTP 500)."],
    ["network", "MCP Docs request failed: network error."],
    ["protocol", "MCP server returned an invalid JSON-RPC response."],
    ["timeout", "MCP Docs initialize timed out."],
    ["unknown", "something else"],
  ])("keeps its %s category and message", (category, message) => {
    const error = new McpError(category, message);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("McpError");
    expect(error.category).toBe(category);
    expect(error.message).toBe(message);
  });

  it("keeps the flattened typed error as cause", () => {
    const cause = new Error("token rejected");
    const error = new McpError("auth", "MCP Docs requires OAuth authentication.", { cause });
    expect(error.cause).toBe(cause);
  });
});

describe("categorizeMcpDiagnosticError", () => {
  it("prefers the typed category over a misleading message", () => {
    const error = new McpError("network", "MCP Docs requires OAuth authentication.");
    expect(categorizeMcpDiagnosticError("MCP Docs requires OAuth authentication.", error)).toBe("network");
    expect(categorizeMcpDiagnosticError("request timed out", new McpError("protocol", "request timed out"))).toBe(
      "protocol",
    );
  });

  it("keeps the string fallback for untyped errors", () => {
    expect(categorizeMcpDiagnosticError("request timed out")).toBe("timeout");
    expect(categorizeMcpDiagnosticError("MCP requires OAuth authentication.")).toBe("auth");
    expect(categorizeMcpDiagnosticError("network error")).toBe("network");
    expect(categorizeMcpDiagnosticError("invalid JSON-RPC response")).toBe("protocol");
    expect(categorizeMcpDiagnosticError("request failed (HTTP 500)")).toBe("http");
    expect(categorizeMcpDiagnosticError("something else", new Error("something else"))).toBe("unknown");
  });
});

describe("typed client errors", () => {
  it("throws an auth-category McpError with the unchanged message when a token cannot be refreshed", async () => {
    const client = new McpHttpClient({
      server: oauthServer(),
      fetcher: challengeFetcher(
        401,
        'Bearer error="invalid_request", error_description="Authorization header is required"',
      ),
    });

    const error = await client.listTools().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).category).toBe("auth");
    expect((error as Error).message).toBe(
      "MCP OAuth MCP requires OAuth authentication. Authorization header is required. Open Agentic Chat settings, authenticate the MCP server, and retry.",
    );
  });

  it("throws an auth-category McpError when a forbidden token cannot be refreshed", async () => {
    const server = oauthServer();
    server.oauth.accessToken = "access-token";
    const client = new McpHttpClient({
      server,
      fetcher: challengeFetcher(403, 'Bearer error="insufficient_scope", scope="openid profile email"'),
    });

    const error = await client.listTools().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).category).toBe("auth");
    expect((error as Error).message).toBe(
      "MCP OAuth MCP refused the OAuth token (HTTP 403). insufficient_scope. Required OAuth scopes: openid profile email. Re-authenticate the MCP server.",
    );
  });
});
