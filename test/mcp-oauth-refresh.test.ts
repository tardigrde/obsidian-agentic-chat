import { describe, expect, it } from "vitest";
import { refreshMcpOAuthToken } from "../src/mcp/oauth";
import { createMcpServerSettings, type McpServerSettings } from "../src/mcp/settings";
import type { WebFetcher, WebHttpResponse } from "../src/tools/web-fetch";

function json(status: number, value: unknown): WebHttpResponse {
  return { status, text: JSON.stringify(value), headers: {} };
}

function oauthServer(): McpServerSettings {
  const server = createMcpServerSettings({
    id: "oauth_mcp",
    name: "OAuth MCP",
    url: "https://oauth-mcp.example.com/mcp",
    authType: "oauth",
  });
  server.oauth = {
    ...server.oauth,
    clientId: "client-1",
    accessToken: "old-access",
    refreshToken: "refresh-1",
    tokenEndpoint: "https://auth.example.com/token",
    expiresAt: 1_000,
  };
  return server;
}

describe("post-216 MCP OAuth refresh flights", () => {
  it("shares one refresh request between cloned server objects with the same id", async () => {
    const original = oauthServer();
    const clone: McpServerSettings = { ...original, oauth: { ...original.oauth } };
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher: WebFetcher = async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return json(200, { access_token: "new-access", refresh_token: "refresh-2", expires_in: 3600 });
      }
      return json(400, { error: "invalid_grant" });
    };

    const first = refreshMcpOAuthToken(original, fetcher, undefined, () => 5_000);
    const second = refreshMcpOAuthToken(clone, fetcher, undefined, () => 5_000);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(calls).toBe(1);
  });

  it("does not wipe newer tokens when a stale refresh returns invalid_grant", async () => {
    const server = oauthServer();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher: WebFetcher = async () => {
      markStarted();
      await gate;
      return json(400, { error: "invalid_grant" });
    };

    const pending = refreshMcpOAuthToken(server, fetcher, undefined, () => 5_000);
    await started;
    server.oauth = {
      ...server.oauth,
      accessToken: "newer-access",
      refreshToken: "newer-refresh",
      expiresAt: 99_000,
      scope: "openid",
    };
    release();

    await expect(pending).resolves.toBe(false);
    expect(server.oauth).toMatchObject({
      accessToken: "newer-access",
      refreshToken: "newer-refresh",
      expiresAt: 99_000,
      scope: "openid",
    });
  });
});
