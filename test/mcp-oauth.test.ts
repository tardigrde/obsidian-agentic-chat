import { describe, expect, it } from "vitest";
import {
  authenticateMcpServer,
  createLoopbackOAuthCallbackReceiver,
  DEFAULT_MCP_OAUTH_CALLBACK_PORT,
  DEFAULT_MCP_OAUTH_REDIRECT_URI,
  discoverMcpOAuthMetadata,
  forgetMcpOAuthTokens,
  hasMcpOAuthAccess,
  MCP_OAUTH_OBSIDIAN_REDIRECT_URI,
  McpOAuthObsidianCallbackBridge,
  mcpResourceUri,
  parseWwwAuthenticate,
  refreshMcpOAuthToken,
  shouldRefreshMcpOAuthToken,
  type McpOAuthCallbackReceiver,
} from "../src/mcp/oauth";
import { createMcpServerSettings } from "../src/mcp/settings";
import type { WebFetcher, WebHttpRequest, WebHttpResponse } from "../src/tools/web-fetch";

const OAUTH_MCP_URL = "https://oauth-mcp.example.com/mcp";
const OAUTH_MCP_RESOURCE_METADATA_URL = "https://oauth-mcp.example.com/.well-known/oauth-protected-resource/mcp";

function json(status: number, value: unknown, headers: Record<string, string> = {}): WebHttpResponse {
  return { status, text: JSON.stringify(value), headers };
}

function createOAuthMcpServer() {
  return createMcpServerSettings({
    id: "oauth_mcp",
    name: "OAuth MCP",
    url: OAUTH_MCP_URL,
    authType: "oauth",
  });
}

describe("MCP OAuth", () => {
  it("parses Bearer authorization challenges", () => {
    expect(
      parseWwwAuthenticate(
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="files:read files:write"',
      ),
    ).toEqual({
      resource_metadata: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      scope: "files:read files:write",
    });
  });

  it("uses the MCP endpoint without query filters as the OAuth resource", () => {
    expect(mcpResourceUri(`${OAUTH_MCP_URL}?toolCategories=gitlab`)).toBe(OAUTH_MCP_URL);
  });

  it("exports the stable redirect URI used for manual OAuth client registration", () => {
    expect(DEFAULT_MCP_OAUTH_REDIRECT_URI).toBe("http://localhost:37123/oauth/callback");
    expect(MCP_OAUTH_OBSIDIAN_REDIRECT_URI).toBe("obsidian://agentic-chat-mcp-oauth");
  });

  it("delivers Obsidian protocol OAuth callbacks for mobile sign-in", async () => {
    const bridge = new McpOAuthObsidianCallbackBridge();
    const receiver = bridge.createReceiver();

    const pending = receiver.waitForCallback("state-1", 1_000);
    expect(bridge.handleProtocolCallback({ action: "agentic-chat-mcp-oauth", code: "auth-code", state: "state-1" })).toBe(true);

    await expect(pending).resolves.toEqual({ code: "auth-code", state: "state-1", error: undefined, errorDescription: undefined });
    await receiver.close();
    expect(bridge.handleProtocolCallback({ action: "agentic-chat-mcp-oauth", code: "late", state: "state-1" })).toBe(false);
  });

  it("surfaces provider errors from Obsidian protocol OAuth callbacks", async () => {
    const bridge = new McpOAuthObsidianCallbackBridge();
    const receiver = bridge.createReceiver();

    const pending = receiver.waitForCallback("state-1", 1_000);
    expect(
      bridge.handleProtocolCallback({
        action: "agentic-chat-mcp-oauth",
        error: "access_denied",
        error_description: "User cancelled",
        state: "state-1",
      }),
    ).toBe(true);

    await expect(pending).resolves.toEqual({
      code: "",
      state: "state-1",
      error: "access_denied",
      errorDescription: "User cancelled",
    });
    await receiver.close();
  });

  it("routes concurrent Obsidian protocol OAuth callbacks by state", async () => {
    const bridge = new McpOAuthObsidianCallbackBridge();
    const first = bridge.createReceiver();
    const second = bridge.createReceiver();

    const firstPending = first.waitForCallback("state-1", 1_000);
    const secondPending = second.waitForCallback("state-2", 1_000);

    expect(bridge.handleProtocolCallback({ code: "second-code", state: "state-2" })).toBe(true);
    await expect(secondPending).resolves.toEqual({
      code: "second-code",
      state: "state-2",
      error: undefined,
      errorDescription: undefined,
    });

    expect(bridge.handleProtocolCallback({ code: "first-code", state: "state-1" })).toBe(true);
    await expect(firstPending).resolves.toEqual({
      code: "first-code",
      state: "state-1",
      error: undefined,
      errorDescription: undefined,
    });

    await first.close();
    await second.close();
  });

  it("falls back to an ephemeral callback port when the stable port is busy for dynamic clients", async () => {
    const listens: number[] = [];
    const fakeHttp = {
      createServer: () => {
        let port = 0;
        let onError: ((error: Error) => void) | undefined;
        return {
          listen(nextPort: number, _hostname: string, callback: () => void) {
            listens.push(nextPort);
            if (nextPort === DEFAULT_MCP_OAUTH_CALLBACK_PORT) {
              onError?.(Object.assign(new Error("address already in use"), { code: "EADDRINUSE" }));
              return;
            }
            port = nextPort === 0 ? 41234 : nextPort;
            callback();
          },
          close: () => undefined,
          address: () => ({ port }),
          on: (_event: "error", callback: (error: Error) => void) => {
            onError = callback;
          },
        };
      },
    };

    const receiver = await createLoopbackOAuthCallbackReceiver({
      allowEphemeralFallback: true,
      http: fakeHttp as never,
    });

    expect(listens).toEqual([DEFAULT_MCP_OAUTH_CALLBACK_PORT, 0]);
    expect(receiver.redirectUri).toBe("http://localhost:41234/oauth/callback");
  });

  it("discovers OAuth metadata, registers a client, opens PKCE auth, and stores tokens", async () => {
    const server = createOAuthMcpServer();
    const requests: WebHttpRequest[] = [];
    let openedUrl = "";
    const receiver: McpOAuthCallbackReceiver = {
      redirectUri: "http://localhost:31234/oauth/callback",
      waitForCallback: async (state) => ({ code: "auth-code", state }),
      close: () => undefined,
    };
    const fetcher: WebFetcher = async (request) => {
      requests.push(request);
      if (request.url === server.url && request.method === "POST") {
        return {
          status: 401,
          text: "",
          headers: {
            "www-authenticate":
              `Bearer resource_metadata="${OAUTH_MCP_RESOURCE_METADATA_URL}", scope="openid profile"`,
          },
        };
      }
      if (request.url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return json(200, {
          authorization_servers: ["https://auth.example.com/tenant"],
          scopes_supported: ["openid", "profile"],
        });
      }
      if (request.url === "https://auth.example.com/.well-known/oauth-authorization-server/tenant") {
        return json(200, {
          issuer: "https://auth.example.com/tenant",
          authorization_endpoint: "https://auth.example.com/tenant/authorize",
          token_endpoint: "https://auth.example.com/tenant/token",
          registration_endpoint: "https://auth.example.com/tenant/register",
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (request.url === "https://auth.example.com/tenant/register") {
        const body = JSON.parse(request.body ?? "{}") as { redirect_uris?: string[] };
        expect(body.redirect_uris).toEqual([receiver.redirectUri]);
        return json(201, { client_id: "client-1" });
      }
      if (request.url === "https://auth.example.com/tenant/token") {
        const body = new URLSearchParams(request.body ?? "");
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("auth-code");
        expect(body.get("client_id")).toBe("client-1");
        expect(body.get("redirect_uri")).toBe(receiver.redirectUri);
        expect(body.get("resource")).toBe(OAUTH_MCP_URL);
        expect(body.get("code_verifier")).toBeTruthy();
        return json(200, {
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid profile",
        });
      }
      return { status: 404, text: "not found", headers: {} };
    };

    await authenticateMcpServer(server, fetcher, {
      callbackReceiver: receiver,
      now: () => 1_000,
      openUrl: (url) => {
        openedUrl = url;
      },
      randomBytes: (size) => new Uint8Array(size).fill(7),
    });

    const authorization = new URL(openedUrl);
    expect(authorization.origin + authorization.pathname).toBe("https://auth.example.com/tenant/authorize");
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("client_id")).toBe("client-1");
    expect(authorization.searchParams.get("redirect_uri")).toBe(receiver.redirectUri);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("resource")).toBe(OAUTH_MCP_URL);
    expect(authorization.searchParams.get("scope")).toBe("openid profile");
    expect(server.oauth).toMatchObject({
      clientId: "client-1",
      dynamicClientRegistration: true,
      registeredRedirectUri: receiver.redirectUri,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      tokenEndpoint: "https://auth.example.com/tenant/token",
      scope: "openid profile",
      expiresAt: 3_601_000,
    });
    expect(requests.map((request) => request.url)).toContain("https://auth.example.com/tenant/register");
  });

  it("uses configured manual OAuth clients without dynamic registration", async () => {
    const server = createOAuthMcpServer();
    server.oauth.clientId = "manual-client";
    server.oauth.clientSecret = "manual-secret";
    const requests: WebHttpRequest[] = [];
    const receiver: McpOAuthCallbackReceiver = {
      redirectUri: DEFAULT_MCP_OAUTH_REDIRECT_URI,
      waitForCallback: async (state) => ({ code: "auth-code", state }),
      close: () => undefined,
    };
    const fetcher: WebFetcher = async (request) => {
      requests.push(request);
      if (request.url === server.url && request.method === "POST") {
        return {
          status: 401,
          text: "",
          headers: { "www-authenticate": `Bearer resource_metadata="${OAUTH_MCP_RESOURCE_METADATA_URL}"` },
        };
      }
      if (request.url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return json(200, {
          authorization_servers: ["https://auth.example.com/tenant"],
          scopes_supported: ["openid"],
        });
      }
      if (request.url === "https://auth.example.com/.well-known/oauth-authorization-server/tenant") {
        return json(200, {
          issuer: "https://auth.example.com/tenant",
          authorization_endpoint: "https://auth.example.com/tenant/authorize",
          token_endpoint: "https://auth.example.com/tenant/token",
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (request.url === "https://auth.example.com/tenant/token") {
        const body = new URLSearchParams(request.body ?? "");
        expect(body.get("client_id")).toBe("manual-client");
        expect(body.get("client_secret")).toBe("manual-secret");
        expect(body.get("redirect_uri")).toBe(DEFAULT_MCP_OAUTH_REDIRECT_URI);
        return json(200, { access_token: "manual-access", expires_in: 3600 });
      }
      return { status: 404, text: "not found", headers: {} };
    };

    await authenticateMcpServer(server, fetcher, {
      callbackReceiver: receiver,
      openUrl: () => undefined,
      randomBytes: (size) => new Uint8Array(size).fill(9),
    });

    expect(requests.map((request) => request.url)).not.toContain("https://auth.example.com/tenant/register");
    expect(server.oauth).toMatchObject({
      clientId: "manual-client",
      clientSecret: "manual-secret",
      dynamicClientRegistration: false,
      accessToken: "manual-access",
    });
  });

  it("rejects advertised OAuth resource metadata from another origin", async () => {
    const server = createOAuthMcpServer();
    const requests: WebHttpRequest[] = [];
    const fetcher: WebFetcher = async (request) => {
      requests.push(request);
      if (request.url === server.url && request.method === "POST") {
        return {
          status: 401,
          text: "",
          headers: {
            "www-authenticate": 'Bearer resource_metadata="https://127.0.0.1:9443/metadata"',
          },
        };
      }
      throw new Error(`unexpected request ${request.url}`);
    };

    await expect(discoverMcpOAuthMetadata(server, fetcher)).rejects.toThrow(/server origin/);
    expect(requests.map((request) => request.url)).toEqual([server.url]);
  });

  it("re-registers a dynamic OAuth client when the loopback redirect URI changes", async () => {
    const server = createOAuthMcpServer();
    server.oauth = {
      ...server.oauth,
      clientId: "old-client",
      dynamicClientRegistration: true,
      registeredRedirectUri: "http://localhost:1111/oauth/callback",
    };
    const requests: WebHttpRequest[] = [];
    const receiver: McpOAuthCallbackReceiver = {
      redirectUri: "http://localhost:2222/oauth/callback",
      waitForCallback: async (state) => ({ code: "auth-code", state }),
      close: () => undefined,
    };
    const fetcher: WebFetcher = async (request) => {
      requests.push(request);
      if (request.url === server.url && request.method === "POST") {
        return {
          status: 401,
          text: "",
          headers: {
            "www-authenticate":
              `Bearer resource_metadata="${OAUTH_MCP_RESOURCE_METADATA_URL}"`,
          },
        };
      }
      if (request.url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return json(200, {
          authorization_servers: ["https://auth.example.com/tenant"],
          scopes_supported: ["openid", "profile"],
        });
      }
      if (request.url === "https://auth.example.com/.well-known/oauth-authorization-server/tenant") {
        return json(200, {
          issuer: "https://auth.example.com/tenant",
          authorization_endpoint: "https://auth.example.com/tenant/authorize",
          token_endpoint: "https://auth.example.com/tenant/token",
          registration_endpoint: "https://auth.example.com/tenant/register",
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (request.url === "https://auth.example.com/tenant/register") {
        const body = JSON.parse(request.body ?? "{}") as { redirect_uris?: string[] };
        expect(body.redirect_uris).toEqual([receiver.redirectUri]);
        return json(201, { client_id: "new-client" });
      }
      if (request.url === "https://auth.example.com/tenant/token") {
        const body = new URLSearchParams(request.body ?? "");
        expect(body.get("client_id")).toBe("new-client");
        expect(body.get("redirect_uri")).toBe(receiver.redirectUri);
        return json(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
      }
      return { status: 404, text: "not found", headers: {} };
    };

    await authenticateMcpServer(server, fetcher, {
      callbackReceiver: receiver,
      openUrl: () => undefined,
      randomBytes: (size) => new Uint8Array(size).fill(8),
    });

    expect(requests.map((request) => request.url)).toContain("https://auth.example.com/tenant/register");
    expect(server.oauth).toMatchObject({
      clientId: "new-client",
      dynamicClientRegistration: true,
      registeredRedirectUri: receiver.redirectUri,
      accessToken: "access-1",
    });
  });

  it("falls back to well-known protected-resource metadata when the auth challenge request fails", async () => {
    const server = createOAuthMcpServer();
    const requests: WebHttpRequest[] = [];
    const fetcher: WebFetcher = async (request) => {
      requests.push(request);
      if (request.url === server.url && request.method === "POST") {
        throw new Error("getaddrinfo EAI_AGAIN oauth-mcp.example.com");
      }
      if (request.url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return json(200, {
          authorization_servers: ["https://auth.example.com/tenant"],
          scopes_supported: ["openid", "profile"],
        });
      }
      if (request.url === "https://auth.example.com/.well-known/oauth-authorization-server/tenant") {
        return json(200, {
          issuer: "https://auth.example.com/tenant",
          authorization_endpoint: "https://auth.example.com/tenant/authorize",
          token_endpoint: "https://auth.example.com/tenant/token",
          registration_endpoint: "https://auth.example.com/tenant/register",
          code_challenge_methods_supported: ["S256"],
        });
      }
      return { status: 404, text: "not found", headers: {} };
    };

    await expect(discoverMcpOAuthMetadata(server, fetcher)).resolves.toMatchObject({
      resourceMetadataUrl: OAUTH_MCP_RESOURCE_METADATA_URL,
      authorizationServer: "https://auth.example.com/tenant",
      scopes: ["openid", "profile"],
      codeChallengeMethods: ["S256"],
    });
    expect(requests.map((request) => request.url)).toEqual([
      server.url,
      OAUTH_MCP_RESOURCE_METADATA_URL,
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
    ]);
  });

  it("falls back to well-known protected-resource metadata when the auth challenge request times out", async () => {
    const server = createOAuthMcpServer();
    const requests: WebHttpRequest[] = [];
    const fetcher: WebFetcher = async (request) => {
      requests.push(request);
      if (request.url === server.url && request.method === "POST") {
        throw new Error("MCP request timed out after 20000 ms while OAuth MCP OAuth discovery.");
      }
      if (request.url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return json(200, {
          authorization_servers: ["https://auth.example.com/tenant"],
          scopes_supported: ["openid", "profile"],
        });
      }
      if (request.url === "https://auth.example.com/.well-known/oauth-authorization-server/tenant") {
        return json(200, {
          issuer: "https://auth.example.com/tenant",
          authorization_endpoint: "https://auth.example.com/tenant/authorize",
          token_endpoint: "https://auth.example.com/tenant/token",
          registration_endpoint: "https://auth.example.com/tenant/register",
          code_challenge_methods_supported: ["S256"],
        });
      }
      return { status: 404, text: "not found", headers: {} };
    };

    await expect(discoverMcpOAuthMetadata(server, fetcher)).resolves.toMatchObject({
      resourceMetadataUrl: OAUTH_MCP_RESOURCE_METADATA_URL,
      authorizationServer: "https://auth.example.com/tenant",
    });
    expect(requests.map((request) => request.url)).toEqual([
      server.url,
      OAUTH_MCP_RESOURCE_METADATA_URL,
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
    ]);
  });

  it("refreshes expired OAuth access tokens", async () => {
    const server = createOAuthMcpServer();
    server.oauth = {
      ...server.oauth,
      clientId: "client-1",
      accessToken: "old-access",
      refreshToken: "refresh-1",
      tokenEndpoint: "https://auth.example.com/token",
      expiresAt: 1_000,
    };
    const fetcher: WebFetcher = async (request) => {
      expect(request.url).toBe("https://auth.example.com/token");
      const body = new URLSearchParams(request.body ?? "");
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-1");
      expect(body.get("resource")).toBe(OAUTH_MCP_URL);
      return json(200, { access_token: "new-access", refresh_token: "refresh-2", expires_in: 10 });
    };

    await expect(refreshMcpOAuthToken(server, fetcher, undefined, () => 5_000)).resolves.toBe(true);
    expect(server.oauth.accessToken).toBe("new-access");
    expect(server.oauth.refreshToken).toBe("refresh-2");
    expect(server.oauth.expiresAt).toBe(15_000);
  });

  it("classifies near-expiry OAuth tokens for refresh before use", () => {
    const server = createOAuthMcpServer();
    server.oauth = {
      ...server.oauth,
      accessToken: "access",
      expiresAt: 70_000,
    };

    expect(hasMcpOAuthAccess(server, 1_000)).toBe(true);
    expect(shouldRefreshMcpOAuthToken(server, 1_000)).toBe(false);
    expect(hasMcpOAuthAccess(server, 20_000)).toBe(false);
    expect(shouldRefreshMcpOAuthToken(server, 20_000)).toBe(true);
  });

  it("forgets OAuth tokens without deleting client setup or secret references", () => {
    const server = createOAuthMcpServer();
    server.knownTools = [{ name: "search", title: "Search", readOnlyHint: false }];
    server.oauth = {
      ...server.oauth,
      clientId: "manual-client",
      clientSecretSecretId: "secret-client",
      clientSecret: "manual-secret",
      dynamicClientRegistration: false,
      registeredRedirectUri: DEFAULT_MCP_OAUTH_REDIRECT_URI,
      authorizationServer: "https://auth.example.com",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      registrationEndpoint: "https://auth.example.com/register",
      resourceMetadataUrl: OAUTH_MCP_RESOURCE_METADATA_URL,
      accessTokenSecretId: "secret-access",
      accessToken: "access",
      refreshTokenSecretId: "secret-refresh",
      refreshToken: "refresh",
      expiresAt: 10_000,
      scope: "openid profile",
    };

    forgetMcpOAuthTokens(server);

    expect(server.oauth).toMatchObject({
      clientId: "manual-client",
      clientSecretSecretId: "secret-client",
      clientSecret: "manual-secret",
      registeredRedirectUri: DEFAULT_MCP_OAUTH_REDIRECT_URI,
      tokenEndpoint: "https://auth.example.com/token",
      accessTokenSecretId: "secret-access",
      accessToken: "",
      refreshTokenSecretId: "secret-refresh",
      refreshToken: "",
      expiresAt: 0,
      scope: "",
    });
    expect(server.knownTools).toEqual([{ name: "search", title: "Search", readOnlyHint: false }]);
  });

  it("forgets stale OAuth tokens when refresh returns invalid_grant", async () => {
    const server = createOAuthMcpServer();
    server.oauth = {
      ...server.oauth,
      clientId: "client-1",
      accessToken: "old-access",
      refreshToken: "bad-refresh",
      tokenEndpoint: "https://auth.example.com/token",
      expiresAt: 1_000,
      scope: "openid",
    };
    const fetcher: WebFetcher = async () => {
      return json(400, { error: "invalid_grant" });
    };

    await expect(refreshMcpOAuthToken(server, fetcher, undefined, () => 5_000)).resolves.toBe(false);
    expect(server.oauth).toMatchObject({
      clientId: "client-1",
      tokenEndpoint: "https://auth.example.com/token",
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
      scope: "",
    });
  });

  it("accepts OAuth token expiry values encoded as strings", async () => {
    const server = createOAuthMcpServer();
    server.oauth = {
      ...server.oauth,
      clientId: "client-1",
      accessToken: "old-access",
      refreshToken: "refresh-1",
      tokenEndpoint: "https://auth.example.com/token",
      expiresAt: 1_000,
    };
    const fetcher: WebFetcher = async () => {
      return json(200, { access_token: "new-access", expires_in: "30" });
    };

    await expect(refreshMcpOAuthToken(server, fetcher, undefined, () => 5_000)).resolves.toBe(true);
    expect(server.oauth.accessToken).toBe("new-access");
    expect(server.oauth.refreshToken).toBe("refresh-1");
    expect(server.oauth.expiresAt).toBe(35_000);
  });

  it("times out OAuth discovery requests instead of hanging sign-in", async () => {
    const server = createOAuthMcpServer();
    const fetcher: WebFetcher = async () => new Promise<WebHttpResponse>(() => undefined);
    const receiver: McpOAuthCallbackReceiver = {
      redirectUri: "http://localhost:31234/oauth/callback",
      waitForCallback: async (state) => ({ code: "unused", state }),
      close: () => undefined,
    };

    await expect(
      authenticateMcpServer(server, fetcher, {
        callbackReceiver: receiver,
        requestTimeoutMs: 1,
        openUrl: () => undefined,
      }),
    ).rejects.toThrow(/timed out.*OAuth MCP OAuth protected-resource metadata/i);
  });
});
