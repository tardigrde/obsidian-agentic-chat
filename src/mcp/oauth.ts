import type { WebFetcher } from "../tools/web-fetch";
import {
  DEFAULT_MCP_OAUTH_SETTINGS,
  type McpServerSettings,
} from "./settings";
import { DEFAULT_MCP_HTTP_TIMEOUT_MS, fetchWithMcpTimeout } from "./http";
import { openAuthorizationUrl } from "./oauth/browser-open";
import { createLoopbackOAuthCallbackReceiver } from "./oauth/callback-receivers";
import { assertPkceSupported, discoverOAuth, scopeFromProtectedResource } from "./oauth/discovery";
import { base64UrlEncode, createPkce, defaultRandomBytes } from "./oauth/pkce";
import {
  applyOAuthToken,
  buildAuthorizationUrl,
  ensureOAuthClient,
  exchangeAuthorizationCode,
  isInvalidRefreshTokenResponse,
} from "./oauth/token";
import type {
  McpOAuthAuthenticateOptions,
  McpOAuthDiscoverySummary,
  McpOAuthProgressEvent,
  OAuthTokenResponse,
} from "./oauth/types";
import { normalizeHttpsUrl, parseJsonObject, stringArray, stringValue } from "./oauth/values";

export { parseWwwAuthenticate } from "./oauth/www-authenticate";
export {
  createLoopbackOAuthCallbackReceiver,
  DEFAULT_MCP_OAUTH_CALLBACK_PORT,
  DEFAULT_MCP_OAUTH_REDIRECT_URI,
  MCP_OAUTH_OBSIDIAN_PROTOCOL_ACTION,
  MCP_OAUTH_OBSIDIAN_REDIRECT_URI,
  McpOAuthObsidianCallbackBridge,
  type McpOAuthCallbackReceiverOptions,
} from "./oauth/callback-receivers";
export type {
  McpOAuthAuthenticateOptions,
  McpOAuthCallback,
  McpOAuthCallbackReceiver,
  McpOAuthDiscoverySummary,
  McpOAuthProgressEvent,
  McpOAuthProgressStage,
  McpOAuthProtocolParams,
  OAuthTokenResponse,
} from "./oauth/types";

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

export async function authenticateMcpServer(
  server: McpServerSettings,
  fetcher: WebFetcher,
  options: McpOAuthAuthenticateOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_MCP_HTTP_TIMEOUT_MS;
  reportOAuthProgress(options, {
    stage: "discovery",
    message: `Discovering OAuth metadata for ${server.name}.`,
    detail: server.url,
  });
  const discovery = await discoverOAuth(server, fetcher, requestTimeoutMs);
  assertPkceSupported(discovery.authServer);
  reportOAuthProgress(options, {
    stage: "callback",
    message: `Starting OAuth callback for ${server.name}.`,
  });

  const hasManualClient = Boolean(server.oauth.clientId && !server.oauth.dynamicClientRegistration);
  const supportsDynamicRegistration = Boolean(stringValue(discovery.authServer.registration_endpoint));
  const receiver = options.callbackReceiver ?? (await createLoopbackOAuthCallbackReceiver({
    allowEphemeralFallback: !hasManualClient && supportsDynamicRegistration,
  }));
  try {
    reportOAuthProgress(options, {
      stage: "callback",
      message: `OAuth callback is listening for ${server.name}.`,
      detail: receiver.redirectUri,
    });
    reportOAuthProgress(options, {
      stage: "registration",
      message: `Preparing OAuth client for ${server.name}.`,
      detail: receiver.redirectUri,
    });
    const client = await ensureOAuthClient(server, fetcher, discovery.authServer, receiver.redirectUri, requestTimeoutMs);
    const pkce = await createPkce(options.randomBytes);
    const state = base64UrlEncode((options.randomBytes ?? defaultRandomBytes)(16));
    // Bind the receiver before opening the browser so a concurrent flow's
    // callback cannot be swallowed by this still-fresh receiver.
    receiver.setExpectedState?.(state);
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: stringValue(discovery.authServer.authorization_endpoint),
      clientId: client.clientId,
      redirectUri: receiver.redirectUri,
      codeChallenge: pkce.challenge,
      state,
      resource: mcpResourceUri(server.url),
      scope: discovery.scope,
    });

    reportOAuthProgress(options, {
      stage: "authorization-url",
      message: `Created OAuth authorization URL for ${server.name}.`,
      detail: authorizationUrl,
    });
    reportOAuthProgress(options, {
      stage: "browser-open",
      message: `Opening browser for ${server.name} OAuth sign-in.`,
    });
    await (options.openUrl ?? openAuthorizationUrl)(authorizationUrl);
    reportOAuthProgress(options, {
      stage: "callback-wait",
      message: `Waiting for ${server.name} OAuth browser callback.`,
      detail: receiver.redirectUri,
    });
    const callback = await receiver.waitForCallback(state, AUTH_TIMEOUT_MS);
    if (callback.error) {
      throw new Error(
        `MCP OAuth authorization failed: ${callback.errorDescription || callback.error}.`,
      );
    }
    if (!callback.code) throw new Error("MCP OAuth authorization did not return a code.");

    reportOAuthProgress(options, {
      stage: "token-exchange",
      message: `Exchanging ${server.name} OAuth authorization code.`,
    });
    const token = await exchangeAuthorizationCode(
      fetcher,
      {
        tokenEndpoint: stringValue(discovery.authServer.token_endpoint),
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code: callback.code,
        codeVerifier: pkce.verifier,
        redirectUri: receiver.redirectUri,
        resource: mcpResourceUri(server.url),
      },
      requestTimeoutMs,
    );

    applyOAuthToken(server, token, {
      now: now(),
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      authorizationServer: discovery.authorizationServer,
      authorizationEndpoint: stringValue(discovery.authServer.authorization_endpoint),
      tokenEndpoint: stringValue(discovery.authServer.token_endpoint),
      registrationEndpoint: stringValue(discovery.authServer.registration_endpoint),
      resourceMetadataUrl: discovery.resourceMetadataUrl,
      fallbackScope: discovery.scope,
      dynamicClientRegistration: client.dynamicClientRegistration,
      registeredRedirectUri: client.registeredRedirectUri,
    });
    server.authType = "oauth";
    reportOAuthProgress(options, {
      stage: "complete",
      message: `OAuth token stored for ${server.name}.`,
    });
  } finally {
    await receiver.close();
  }
}

function reportOAuthProgress(
  options: McpOAuthAuthenticateOptions,
  event: McpOAuthProgressEvent,
): void {
  const detail = event.detail ? ` ${event.detail}` : "";
  console.warn(`Agentic Chat MCP OAuth [${event.stage}]: ${event.message}${detail}`);
  options.onProgress?.(event);
}

export async function discoverMcpOAuthMetadata(
  server: McpServerSettings,
  fetcher: WebFetcher,
  requestTimeoutMs = DEFAULT_MCP_HTTP_TIMEOUT_MS,
): Promise<McpOAuthDiscoverySummary> {
  const discovery = await discoverOAuth(server, fetcher, requestTimeoutMs);
  return {
    resourceMetadataUrl: discovery.resourceMetadataUrl,
    authorizationServer: discovery.authorizationServer,
    authorizationEndpoint: stringValue(discovery.authServer.authorization_endpoint),
    tokenEndpoint: stringValue(discovery.authServer.token_endpoint),
    registrationEndpoint: stringValue(discovery.authServer.registration_endpoint),
    scopes: discovery.scope
      ? discovery.scope.split(/\s+/).filter(Boolean)
      : scopeFromProtectedResource(discovery.protectedResource).split(/\s+/).filter(Boolean),
    codeChallengeMethods: stringArray(discovery.authServer.code_challenge_methods_supported),
  };
}

interface McpOAuthRefreshFlight {
  scope: string;
  leader: McpServerSettings;
  promise: Promise<boolean>;
}

/**
 * One refresh per stable server id. Plugin MCP servers are cloned on each
 * runtime load, so object identity cannot dedupe concurrent refreshes; the
 * stable id can. Two 401/403 responses can race with the same refresh token;
 * the loser would receive invalid_grant and wipe the winner's tokens.
 *
 * The flight owns no caller's abort signal: stopping one caller must not stop
 * the shared fetch or another live caller. Each caller races its own signal.
 */
const refreshFlights = new Map<string, McpOAuthRefreshFlight>();

function refreshFlightKey(server: McpServerSettings): string {
  return server.id || server.url;
}

export function refreshMcpOAuthToken(
  server: McpServerSettings,
  fetcher: WebFetcher,
  signal?: AbortSignal,
  now: () => number = Date.now,
  requestTimeoutMs = DEFAULT_MCP_HTTP_TIMEOUT_MS,
  requestedScope?: string,
): Promise<boolean> {
  const key = refreshFlightKey(server);
  const scope = requestedScope?.trim() ?? "";
  const existing = refreshFlights.get(key);
  if (existing?.scope === scope) {
    return waitForMcpOAuthRefresh(followMcpOAuthRefresh(existing, server), signal);
  }
  if (existing) {
    // A different scope must wait for the current refresh to rotate the token,
    // then refresh again with the wider scope. Copy the rotated state first so
    // this clone does not send the already-used refresh token.
    const promise = existing.promise.then(
      (refreshed) => {
        if (refreshed) copyMcpOAuthState(existing.leader, server);
        return performMcpOAuthRefresh(server, fetcher, now, requestTimeoutMs, requestedScope);
      },
      () => performMcpOAuthRefresh(server, fetcher, now, requestTimeoutMs, requestedScope),
    );
    return waitForMcpOAuthRefresh(trackMcpOAuthRefresh(key, scope, server, promise), signal);
  }
  const promise = performMcpOAuthRefresh(server, fetcher, now, requestTimeoutMs, requestedScope);
  return waitForMcpOAuthRefresh(trackMcpOAuthRefresh(key, scope, server, promise), signal);
}

function followMcpOAuthRefresh(
  flight: McpOAuthRefreshFlight,
  follower: McpServerSettings,
): Promise<boolean> {
  return flight.promise.then((refreshed) => {
    if (refreshed) copyMcpOAuthState(flight.leader, follower);
    return refreshed;
  });
}

/** Copy the fields a follower needs to use the leader's refreshed tokens. */
function copyMcpOAuthState(from: McpServerSettings, to: McpServerSettings): void {
  if (from === to) return;
  to.authType = from.authType;
  to.oauth = { ...from.oauth };
}

/** A caller's abort rejects only that caller; the shared flight continues. */
function waitForMcpOAuthRefresh(promise: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return promise;
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error("Aborted."));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    // Attach the handler before the early abort return: an already-aborted
    // caller must still observe a later shared rejection.
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function trackMcpOAuthRefresh(
  key: string,
  scope: string,
  leader: McpServerSettings,
  promise: Promise<boolean>,
): Promise<boolean> {
  const flight: McpOAuthRefreshFlight = { scope, leader, promise };
  refreshFlights.set(key, flight);
  void promise
    .finally(() => {
      if (refreshFlights.get(key) === flight) refreshFlights.delete(key);
    })
    .catch(() => undefined);
  return promise;
}

async function performMcpOAuthRefresh(
  server: McpServerSettings,
  fetcher: WebFetcher,
  now: () => number = Date.now,
  requestTimeoutMs = DEFAULT_MCP_HTTP_TIMEOUT_MS,
  requestedScope?: string,
): Promise<boolean> {
  if (server.authType !== "oauth") return false;
  if (!server.oauth.refreshToken || !server.oauth.tokenEndpoint || !server.oauth.clientId) return false;
  const refreshTokenUsed = server.oauth.refreshToken;
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshTokenUsed);
  body.set("client_id", server.oauth.clientId);
  body.set("resource", mcpResourceUri(server.url));
  if (requestedScope?.trim()) body.set("scope", requestedScope.trim());
  if (server.oauth.clientSecret) body.set("client_secret", server.oauth.clientSecret);
  const response = await fetchWithMcpTimeout(
    fetcher,
    {
      url: server.oauth.tokenEndpoint,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    `${server.name} OAuth token refresh`,
    undefined,
    requestTimeoutMs,
  );
  if (response.status < 200 || response.status >= 300) {
    // A stale failure must not wipe tokens a newer refresh already installed.
    if (isInvalidRefreshTokenResponse(response) && server.oauth.refreshToken === refreshTokenUsed) {
      forgetMcpOAuthTokens(server);
    }
    return false;
  }
  const token = parseJsonObject<OAuthTokenResponse>(response.text, "OAuth token refresh response");
  applyOAuthToken(server, token, {
    now: now(),
    clientId: server.oauth.clientId,
    clientSecret: server.oauth.clientSecret,
    authorizationServer: server.oauth.authorizationServer,
    authorizationEndpoint: server.oauth.authorizationEndpoint,
    tokenEndpoint: server.oauth.tokenEndpoint,
    registrationEndpoint: server.oauth.registrationEndpoint,
    resourceMetadataUrl: server.oauth.resourceMetadataUrl,
    fallbackScope: requestedScope?.trim() || server.oauth.scope,
    dynamicClientRegistration: server.oauth.dynamicClientRegistration,
    registeredRedirectUri: server.oauth.registeredRedirectUri,
  });
  return true;
}

export function shouldRefreshMcpOAuthToken(server: McpServerSettings, now: number = Date.now()): boolean {
  if (server.authType !== "oauth") return false;
  if (!server.oauth.accessToken) return false;
  return server.oauth.expiresAt > 0 && server.oauth.expiresAt - now <= TOKEN_EXPIRY_SKEW_MS;
}

export function hasMcpOAuthAccess(server: McpServerSettings, now: number = Date.now()): boolean {
  if (server.authType !== "oauth" || !server.oauth.accessToken) return false;
  return server.oauth.expiresAt === 0 || server.oauth.expiresAt > now + TOKEN_EXPIRY_SKEW_MS;
}

export function clearMcpOAuth(server: McpServerSettings): void {
  const { clientSecretSecretId, accessTokenSecretId, refreshTokenSecretId } = server.oauth;
  server.oauth = { ...DEFAULT_MCP_OAUTH_SETTINGS, clientSecretSecretId, accessTokenSecretId, refreshTokenSecretId };
  if (server.authType === "oauth") return;
  server.authType = "oauth";
}

export function forgetMcpOAuthTokens(server: McpServerSettings): void {
  server.oauth = {
    ...server.oauth,
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
    scope: "",
  };
  if (server.authType !== "oauth") server.authType = "oauth";
}

export function mcpResourceUri(input: string): string {
  const url = normalizeHttpsUrl(input);
  url.hash = "";
  url.search = "";
  if (url.pathname === "/") url.pathname = "";
  return url.toString().replace(/\/$/, "");
}
