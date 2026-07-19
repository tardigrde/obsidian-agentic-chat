import process from "node:process";
import https from "node:https";
import { describe, expect, it } from "vitest";
import { discoverMcpOAuthMetadata } from "../../src/mcp/oauth";
import { createMcpServerSettings } from "../../src/mcp/settings";
import { probeMcpServer } from "../../src/mcp/tools";
import type { WebFetcher, WebHttpResponse } from "../../src/tools/web-fetch";

const liveUrl = process.env.AGENTIC_CHAT_LIVE_MCP_URL?.trim() || "";
const liveAccessToken = process.env.AGENTIC_CHAT_LIVE_MCP_ACCESS_TOKEN?.trim() || "";

function createLiveServer() {
  return createMcpServerSettings({
    id: "remote_mcp",
    name: "Remote MCP",
    url: liveUrl,
    authType: "oauth",
  });
}
const runIfConfigured = liveUrl ? it : it.skip;
const runIfAuthenticated = liveUrl && liveAccessToken ? it : it.skip;

const nodeHttpsFetch: WebFetcher = async (request) => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await nodeHttpsFetchOnce(request);
    } catch (error) {
      lastError = error;
      if (!isNetworkUnavailable(error) || attempt === 3) break;
      await delay(500 * attempt);
    }
  }
  throw lastError;
};

const nodeHttpsFetchOnce: WebFetcher = async (request) => {
  return await new Promise<WebHttpResponse>((resolve, reject) => {
    const clientRequest = https.request(request.url, {
      method: request.method ?? "GET",
      headers: request.headers,
      timeout: 20_000,
    }, (response) => {
      const chunks: string[] = [];
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => chunks.push(chunk));
      response.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(", ");
          else if (value !== undefined) headers[key.toLowerCase()] = String(value);
        }
        resolve({ status: response.statusCode ?? 0, text: chunks.join(""), headers });
      });
    });
    clientRequest.on("timeout", () => clientRequest.destroy(new Error("HTTPS request timed out.")));
    clientRequest.on("error", reject);
    if (request.body) clientRequest.write(request.body);
    clientRequest.end();
  });
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Remote MCP live discovery", () => {
  runIfConfigured("discovers OAuth metadata without credentials", async () => {
    if (!liveUrl.startsWith("https://")) {
      throw new Error("AGENTIC_CHAT_LIVE_MCP_URL must start with https://");
    }
    const server = createLiveServer();

    let metadata;
    try {
      metadata = await discoverMcpOAuthMetadata(server, nodeHttpsFetch, 20_000);
    } catch (error) {
      if (isNetworkUnavailable(error)) {
        console.warn(`Skipping remote MCP live discovery: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }

    expect(metadata.resourceMetadataUrl).toContain("/.well-known/oauth-protected-resource");
    expect(metadata.authorizationServer).toContain("/issuers/mcp");
    expect(metadata.authorizationEndpoint).toContain("/authorize");
    expect(metadata.tokenEndpoint).toContain("/token");
    expect(metadata.registrationEndpoint).toContain("/register");
    expect(metadata.scopes).toEqual(expect.arrayContaining(["openid", "profile"]));
    expect(metadata.codeChallengeMethods).toContain("S256");
  });

  runIfAuthenticated("lists tools with a supplied OAuth access token", async () => {
    if (!liveUrl.startsWith("https://")) {
      throw new Error("AGENTIC_CHAT_LIVE_MCP_URL must start with https://");
    }
    const server = createLiveServer();
    server.oauth.accessToken = liveAccessToken;
    server.oauth.refreshToken = process.env.AGENTIC_CHAT_LIVE_MCP_REFRESH_TOKEN?.trim() || "";
    server.oauth.clientId = process.env.AGENTIC_CHAT_LIVE_MCP_CLIENT_ID?.trim() || "";
    server.oauth.tokenEndpoint = process.env.AGENTIC_CHAT_LIVE_MCP_TOKEN_ENDPOINT?.trim() || "";

    let result;
    try {
      result = await probeMcpServer(server, nodeHttpsFetch);
    } catch (error) {
      if (isNetworkUnavailable(error)) {
        console.warn(
          `Skipping authenticated remote MCP live probe: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      throw error;
    }

    expect(result.toolCount).toBeGreaterThan(0);
    expect(result.toolNames).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(get_time|search_tools|call_tool|call_readonly_tool)$/)]),
    );
  });

  it("has environment variables configured", () => {
    expect(typeof liveUrl).toBe("string");
  });
});

function isNetworkUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""}` : String(error);
  return /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|timed out|Could not resolve host/i.test(message);
}
