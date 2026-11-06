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
    expect(original.oauth).toMatchObject({
      accessToken: "new-access",
      refreshToken: "refresh-2",
      expiresAt: 3_605_000,
    });
    expect(clone.oauth).toMatchObject({
      accessToken: "new-access",
      refreshToken: "refresh-2",
      expiresAt: 3_605_000,
    });
  });

  it("gives a wider-scope follower the rotated refresh token", async () => {
    const original = oauthServer();
    const clone: McpServerSettings = { ...original, oauth: { ...original.oauth } };
    let calls = 0;
    const bodies: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher: WebFetcher = async (request) => {
      calls += 1;
      bodies.push(request.body ?? "");
      if (calls === 1) {
        await gate;
        return json(200, { access_token: "new-access", refresh_token: "refresh-2", expires_in: 3600 });
      }
      return json(200, { access_token: "scoped-access", refresh_token: "refresh-3", expires_in: 3600 });
    };

    const first = refreshMcpOAuthToken(original, fetcher, undefined, () => 5_000);
    const second = refreshMcpOAuthToken(clone, fetcher, undefined, () => 5_000, undefined, "openid");
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(calls).toBe(2);
    expect(new URLSearchParams(bodies[1]).get("refresh_token")).toBe("refresh-2");
    expect(clone.oauth).toMatchObject({
      accessToken: "scoped-access",
      refreshToken: "refresh-3",
    });
  });

  it("keeps the shared refresh alive when one caller aborts", async () => {
    const leader = oauthServer();
    const follower: McpServerSettings = { ...leader, oauth: { ...leader.oauth } };
    const controller = new AbortController();
    let calls = 0;
    let release!: () => void;
    const fetcher: WebFetcher = (_request, signal) => {
      calls += 1;
      return new Promise<WebHttpResponse>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Aborted.")), { once: true });
        release = () => resolve(json(200, { access_token: "new-access", refresh_token: "refresh-2", expires_in: 3600 }));
      });
    };

    const aborted = refreshMcpOAuthToken(leader, fetcher, controller.signal, () => 5_000);
    const followerResult = refreshMcpOAuthToken(follower, fetcher, undefined, () => 5_000);
    const abortedResult = expect(aborted).rejects.toThrow("Aborted.");
    controller.abort();
    release();

    await abortedResult;
    await expect(followerResult).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(follower.oauth).toMatchObject({
      accessToken: "new-access",
      refreshToken: "refresh-2",
    });
  });

  it("observes the shared rejection when the follower is already aborted", async () => {
    const leader = oauthServer();
    const follower: McpServerSettings = { ...leader, oauth: { ...leader.oauth } };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher: WebFetcher = async () => {
      await gate;
      throw new Error("network down");
    };
    const leaderResult = refreshMcpOAuthToken(leader, fetcher, undefined, () => 5_000);
    const controller = new AbortController();
    controller.abort();
    const followerResult = refreshMcpOAuthToken(follower, fetcher, controller.signal, () => 5_000);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const leaderRejected = expect(leaderResult).rejects.toThrow("network down");
      release();
      await leaderRejected;
      await expect(followerResult).rejects.toThrow("Aborted.");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("starts a new flight after a rejected or failed refresh", async () => {
    const server = oauthServer();
    let calls = 0;
    const fetcher: WebFetcher = async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      if (calls === 2) return json(500, { error: "server_error" });
      return json(200, { access_token: "retry-access", refresh_token: "retry-refresh", expires_in: 3600 });
    };

    await expect(refreshMcpOAuthToken(server, fetcher, undefined, () => 5_000)).rejects.toThrow(
      "network down",
    );
    expect(server.oauth).toMatchObject({ accessToken: "old-access", refreshToken: "refresh-1" });

    await expect(refreshMcpOAuthToken(server, fetcher, undefined, () => 5_000)).resolves.toBe(false);
    expect(server.oauth).toMatchObject({ accessToken: "old-access", refreshToken: "refresh-1" });

    await expect(refreshMcpOAuthToken(server, fetcher, undefined, () => 5_000)).resolves.toBe(true);
    expect(calls).toBe(3);
    expect(server.oauth).toMatchObject({
      accessToken: "retry-access",
      refreshToken: "retry-refresh",
    });
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
