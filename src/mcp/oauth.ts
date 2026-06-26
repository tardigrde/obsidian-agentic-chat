import type { WebFetcher } from "../tools/web-fetch";
import {
  DEFAULT_MCP_OAUTH_SETTINGS,
  type McpServerSettings,
} from "./settings";
import { DEFAULT_MCP_HTTP_TIMEOUT_MS, fetchWithMcpTimeout } from "./http";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const ACCEPT = "application/json, text/event-stream";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
export const DEFAULT_MCP_OAUTH_CALLBACK_PORT = 37123;
export const DEFAULT_MCP_OAUTH_REDIRECT_URI = `http://localhost:${DEFAULT_MCP_OAUTH_CALLBACK_PORT}/oauth/callback`;

interface OAuthProtectedResourceMetadata {
  authorization_servers?: unknown;
  scopes_supported?: unknown;
}

interface OAuthAuthorizationServerMetadata {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  registration_endpoint?: unknown;
  scopes_supported?: unknown;
  code_challenge_methods_supported?: unknown;
  client_id_metadata_document_supported?: unknown;
}

interface OAuthClientRegistrationResponse {
  client_id?: unknown;
  client_secret?: unknown;
}

interface OAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

interface AuthChallenge {
  resourceMetadataUrl: string;
  scope: string;
}

interface OAuthDiscovery {
  protectedResource: OAuthProtectedResourceMetadata;
  resourceMetadataUrl: string;
  authServer: OAuthAuthorizationServerMetadata;
  authorizationServer: string;
  scope: string;
}

export interface McpOAuthDiscoverySummary {
  resourceMetadataUrl: string;
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  scopes: string[];
  codeChallengeMethods: string[];
}

export interface McpOAuthCallback {
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
}

export interface McpOAuthCallbackReceiver {
  redirectUri: string;
  waitForCallback(expectedState: string, timeoutMs: number): Promise<McpOAuthCallback>;
  close(): void | Promise<void>;
}

export interface McpOAuthCallbackReceiverOptions {
  allowEphemeralFallback?: boolean;
  http?: NodeHttpModule;
}

export type McpOAuthProgressStage =
  | "discovery"
  | "callback"
  | "registration"
  | "authorization-url"
  | "browser-open"
  | "callback-wait"
  | "token-exchange"
  | "complete";

export interface McpOAuthProgressEvent {
  stage: McpOAuthProgressStage;
  message: string;
  detail?: string;
}

export interface McpOAuthAuthenticateOptions {
  openUrl?: (url: string) => void | Promise<void>;
  callbackReceiver?: McpOAuthCallbackReceiver;
  onProgress?: (event: McpOAuthProgressEvent) => void;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  requestTimeoutMs?: number;
}

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
    message: `Starting localhost OAuth callback for ${server.name}.`,
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

export async function refreshMcpOAuthToken(
  server: McpServerSettings,
  fetcher: WebFetcher,
  signal?: AbortSignal,
  now: () => number = Date.now,
  requestTimeoutMs = DEFAULT_MCP_HTTP_TIMEOUT_MS,
  requestedScope?: string,
): Promise<boolean> {
  if (server.authType !== "oauth") return false;
  if (!server.oauth.refreshToken || !server.oauth.tokenEndpoint || !server.oauth.clientId) return false;
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", server.oauth.refreshToken);
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
    signal,
    requestTimeoutMs,
  );
  if (response.status < 200 || response.status >= 300) return false;
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

export function mcpResourceUri(input: string): string {
  const url = normalizeHttpsUrl(input);
  url.hash = "";
  url.search = "";
  if (url.pathname === "/") url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

export function parseWwwAuthenticate(header: string): Record<string, string> {
  const trimmed = header.trim();
  const withoutScheme = trimmed.replace(/^Bearer\s+/i, "");
  const params: Record<string, string> = {};
  let index = 0;
  while (index < withoutScheme.length) {
    while (/[\s,]/.test(withoutScheme[index] ?? "")) index += 1;
    const keyStart = index;
    while (index < withoutScheme.length && /[A-Za-z0-9_.-]/.test(withoutScheme[index])) index += 1;
    const key = withoutScheme.slice(keyStart, index);
    while (/\s/.test(withoutScheme[index] ?? "")) index += 1;
    if (!key || withoutScheme[index] !== "=") break;
    index += 1;
    while (/\s/.test(withoutScheme[index] ?? "")) index += 1;
    let value = "";
    if (withoutScheme[index] === '"') {
      index += 1;
      while (index < withoutScheme.length) {
        const char = withoutScheme[index];
        if (char === "\\") {
          value += withoutScheme[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (char === '"') {
          index += 1;
          break;
        }
        value += char;
        index += 1;
      }
    } else {
      const valueStart = index;
      while (index < withoutScheme.length && withoutScheme[index] !== ",") index += 1;
      value = withoutScheme.slice(valueStart, index).trim();
    }
    params[key] = value;
  }
  return params;
}

async function discoverOAuth(
  server: McpServerSettings,
  fetcher: WebFetcher,
  requestTimeoutMs: number,
): Promise<OAuthDiscovery> {
  const challenge = await readAuthChallenge(server, fetcher, requestTimeoutMs).catch((error: unknown) => {
    if (!isTransientOAuthChallengeFailure(error)) throw error;
    return { resourceMetadataUrl: "", scope: "" };
  });
  let resourceMetadataUrl = challenge.resourceMetadataUrl;
  let protectedResource: OAuthProtectedResourceMetadata;
  if (resourceMetadataUrl) {
    resourceMetadataUrl = normalizeAdvertisedResourceMetadataUrl(resourceMetadataUrl, server.url).toString();
    protectedResource = await fetchJson<OAuthProtectedResourceMetadata>(
      fetcher,
      resourceMetadataUrl,
      "OAuth protected resource metadata",
      requestTimeoutMs,
    );
  } else {
    const discovered = await firstReachableProtectedResourceMetadata(server, fetcher, requestTimeoutMs);
    resourceMetadataUrl = discovered.url;
    protectedResource = discovered.metadata;
  }
  const authorizationServer = firstString(protectedResource.authorization_servers);
  if (!authorizationServer) {
    throw new Error("MCP OAuth protected resource metadata did not include an authorization server.");
  }
  const authServer = await discoverAuthorizationServerMetadata(fetcher, authorizationServer, requestTimeoutMs);
  const scope = challenge.scope || scopeFromProtectedResource(protectedResource);
  return { protectedResource, resourceMetadataUrl, authServer, authorizationServer, scope };
}

function isTransientOAuthChallengeFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""}` : String(error);
  return /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|timeout|network error|Could not resolve host/i.test(message);
}

async function readAuthChallenge(
  server: McpServerSettings,
  fetcher: WebFetcher,
  requestTimeoutMs: number,
): Promise<AuthChallenge> {
  const response = await fetchWithMcpTimeout(
    fetcher,
    {
      url: normalizeHttpsUrl(server.url).toString(),
      method: "POST",
      headers: {
        Accept: ACCEPT,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "obsidian-agentic-chat", title: "Agentic Chat", version: "0.0.0" },
        },
      }),
    },
    `${server.name} OAuth discovery`,
    undefined,
    requestTimeoutMs,
  );
  const params = parseWwwAuthenticate(response.headers["www-authenticate"] ?? "");
  return {
    resourceMetadataUrl: params.resource_metadata || "",
    scope: params.scope || "",
  };
}

async function firstReachableProtectedResourceMetadata(
  server: McpServerSettings,
  fetcher: WebFetcher,
  requestTimeoutMs: number,
): Promise<{ url: string; metadata: OAuthProtectedResourceMetadata }> {
  const candidates = protectedResourceMetadataUrls(server.url);
  for (const url of candidates) {
    const response = await fetchWithMcpTimeout(
      fetcher,
      { url, method: "GET", headers: { Accept: "application/json" } },
      `${server.name} OAuth protected-resource metadata`,
      undefined,
      requestTimeoutMs,
    );
    if (response.status >= 200 && response.status < 300) {
      return {
        url,
        metadata: parseJsonObject<OAuthProtectedResourceMetadata>(response.text, "OAuth protected resource metadata"),
      };
    }
  }
  throw new Error("MCP OAuth protected resource metadata was not advertised and no well-known metadata URL responded.");
}

function protectedResourceMetadataUrls(input: string): string[] {
  const url = normalizeHttpsUrl(input);
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/$/, "");
  const origin = url.origin;
  const urls = [];
  if (path && path !== "/") urls.push(`${origin}/.well-known/oauth-protected-resource${path}`);
  urls.push(`${origin}/.well-known/oauth-protected-resource`);
  return [...new Set(urls)];
}

async function discoverAuthorizationServerMetadata(
  fetcher: WebFetcher,
  issuer: string,
  requestTimeoutMs: number,
): Promise<OAuthAuthorizationServerMetadata> {
  const errors: string[] = [];
  for (const url of authorizationServerMetadataUrls(issuer)) {
    const response = await fetchWithMcpTimeout(
      fetcher,
      { url, method: "GET", headers: { Accept: "application/json" } },
      "OAuth authorization server metadata",
      undefined,
      requestTimeoutMs,
    );
    if (response.status >= 200 && response.status < 300) {
      return parseJsonObject<OAuthAuthorizationServerMetadata>(response.text, "OAuth authorization server metadata");
    }
    errors.push(`${url} -> HTTP ${response.status}`);
  }
  throw new Error(`Could not discover OAuth authorization server metadata: ${errors.join("; ")}.`);
}

function authorizationServerMetadataUrls(input: string): string[] {
  const url = normalizeHttpsUrl(input);
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/$/, "");
  const origin = url.origin;
  if (path && path !== "/") {
    return [
      `${origin}/.well-known/oauth-authorization-server${path}`,
      `${origin}/.well-known/openid-configuration${path}`,
      `${origin}${path}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}/.well-known/openid-configuration`,
  ];
}

function assertPkceSupported(metadata: OAuthAuthorizationServerMetadata): void {
  const methods = stringArray(metadata.code_challenge_methods_supported);
  if (!methods.includes("S256")) {
    throw new Error("MCP OAuth authorization server does not advertise PKCE S256 support.");
  }
  if (!stringValue(metadata.authorization_endpoint) || !stringValue(metadata.token_endpoint)) {
    throw new Error("MCP OAuth authorization server metadata is missing authorization or token endpoints.");
  }
}

async function ensureOAuthClient(
  server: McpServerSettings,
  fetcher: WebFetcher,
  metadata: OAuthAuthorizationServerMetadata,
  redirectUri: string,
  requestTimeoutMs: number,
): Promise<{
  clientId: string;
  clientSecret: string;
  dynamicClientRegistration: boolean;
  registeredRedirectUri: string;
}> {
  if (
    server.oauth.clientId &&
    (!server.oauth.dynamicClientRegistration || server.oauth.registeredRedirectUri === redirectUri)
  ) {
    return {
      clientId: server.oauth.clientId,
      clientSecret: server.oauth.clientSecret,
      dynamicClientRegistration: server.oauth.dynamicClientRegistration,
      registeredRedirectUri: server.oauth.registeredRedirectUri,
    };
  }
  const registrationEndpoint = stringValue(metadata.registration_endpoint);
  if (!registrationEndpoint) {
    throw new Error(
      "MCP OAuth authorization server does not support dynamic client registration. Enter a client id in settings.",
    );
  }
  const response = await fetchWithMcpTimeout(
    fetcher,
    {
      url: registrationEndpoint,
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Agentic Chat for Obsidian",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    },
    `${server.name} OAuth client registration`,
    undefined,
    requestTimeoutMs,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`MCP OAuth dynamic client registration failed (HTTP ${response.status}).`);
  }
  const registered = parseJsonObject<OAuthClientRegistrationResponse>(
    response.text,
    "OAuth client registration response",
  );
  const clientId = stringValue(registered.client_id);
  if (!clientId) throw new Error("MCP OAuth client registration response did not include a client_id.");
  return {
    clientId,
    clientSecret: stringValue(registered.client_secret),
    dynamicClientRegistration: true,
    registeredRedirectUri: redirectUri,
  };
}

function buildAuthorizationUrl(options: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
  scope: string;
}): string {
  const url = new URL(options.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  url.searchParams.set("resource", options.resource);
  if (options.scope) url.searchParams.set("scope", options.scope);
  return url.toString();
}

async function exchangeAuthorizationCode(
  fetcher: WebFetcher,
  options: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    resource: string;
  },
  requestTimeoutMs: number,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", options.code);
  body.set("redirect_uri", options.redirectUri);
  body.set("client_id", options.clientId);
  body.set("code_verifier", options.codeVerifier);
  body.set("resource", options.resource);
  if (options.clientSecret) body.set("client_secret", options.clientSecret);
  const response = await fetchWithMcpTimeout(
    fetcher,
    {
      url: options.tokenEndpoint,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    "OAuth token exchange",
    undefined,
    requestTimeoutMs,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`MCP OAuth token exchange failed (HTTP ${response.status}).`);
  }
  return parseJsonObject<OAuthTokenResponse>(response.text, "OAuth token response");
}

function applyOAuthToken(
  server: McpServerSettings,
  token: OAuthTokenResponse,
  context: {
    now: number;
    clientId: string;
    clientSecret: string;
    authorizationServer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint: string;
    resourceMetadataUrl: string;
    fallbackScope: string;
    dynamicClientRegistration: boolean;
    registeredRedirectUri: string;
  },
): void {
  const accessToken = stringValue(token.access_token);
  if (!accessToken) throw new Error("MCP OAuth token response did not include an access_token.");
  const expiresIn = finitePositiveNumber(token.expires_in);
  const { clientSecretSecretId, accessTokenSecretId, refreshTokenSecretId } = server.oauth;
  server.oauth = {
    clientId: context.clientId,
    clientSecretSecretId,
    clientSecret: context.clientSecret,
    dynamicClientRegistration: context.dynamicClientRegistration,
    registeredRedirectUri: context.registeredRedirectUri,
    authorizationServer: context.authorizationServer,
    authorizationEndpoint: context.authorizationEndpoint,
    tokenEndpoint: context.tokenEndpoint,
    registrationEndpoint: context.registrationEndpoint,
    resourceMetadataUrl: context.resourceMetadataUrl,
    accessTokenSecretId,
    accessToken,
    refreshTokenSecretId,
    refreshToken: stringValue(token.refresh_token) || server.oauth.refreshToken,
    expiresAt: expiresIn > 0 ? context.now + expiresIn * 1000 : 0,
    scope: stringValue(token.scope) || context.fallbackScope,
  };
}

async function createPkce(randomBytes: ((size: number) => Uint8Array) | undefined): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = base64UrlEncode((randomBytes ?? defaultRandomBytes)(32));
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge };
}

async function sha256Base64Url(input: string): Promise<string> {
  const subtle = window.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is required for MCP OAuth PKCE.");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function defaultRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  window.crypto.getRandomValues(bytes);
  return bytes;
}

export async function createLoopbackOAuthCallbackReceiver(
  options: McpOAuthCallbackReceiverOptions = {},
): Promise<McpOAuthCallbackReceiver> {
  const http = options.http ?? requireNodeHttp();
  let resolveCallback: ((callback: McpOAuthCallback) => void) | null = null;
  const callbackPromise = new Promise<McpOAuthCallback>((resolve) => {
    resolveCallback = resolve;
  });

  const createServer = (): NodeHttpServer => http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const callback: McpOAuthCallback = {
      code: requestUrl.searchParams.get("code") ?? "",
      state: requestUrl.searchParams.get("state") ?? "",
      error: requestUrl.searchParams.get("error") ?? undefined,
      errorDescription: requestUrl.searchParams.get("error_description") ?? undefined,
    };
    response.statusCode = callback.code || callback.error ? 200 : 400;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      "<!doctype html><title>Agentic Chat OAuth</title><body>" +
        (response.statusCode === 200
          ? "Agentic Chat authentication is complete. You can close this window."
          : "Agentic Chat authentication did not return an authorization code.") +
        "</body>",
    );
    resolveCallback?.(callback);
  });

  let server = createServer();
  const address = await listenLoopbackOAuthServer(server, DEFAULT_MCP_OAUTH_CALLBACK_PORT).catch(async (error: unknown) => {
    server.close();
    if (!options.allowEphemeralFallback || !isAddressInUse(error)) throw error;
    server = createServer();
    return await listenLoopbackOAuthServer(server, 0);
  });

  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start MCP OAuth loopback callback server.");
  }

  return {
    redirectUri: `http://localhost:${address.port}/oauth/callback`,
    waitForCallback: async (expectedState, timeoutMs) => {
      let timeoutId: number | undefined;
      const timeout = new Promise<McpOAuthCallback>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error("Timed out waiting for MCP OAuth callback.")), timeoutMs);
      });
      const callback = await Promise.race([callbackPromise, timeout]).finally(() => {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      });
      if (callback.state !== expectedState) throw new Error("MCP OAuth callback state did not match.");
      return callback;
    },
    close: () => {
      server.close();
    },
  };
}

async function listenLoopbackOAuthServer(
  server: NodeHttpServer,
  port: number,
): Promise<{ port: number } | string | null> {
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "localhost", resolve);
  });
  return server.address();
}

function isAddressInUse(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(message);
}

function requireNodeHttp(): NodeHttpModule {
  const requireFn = optionalNodeRequire();
  if (!requireFn) {
    throw new Error("MCP OAuth sign-in requires Obsidian desktop so Agentic Chat can open a localhost callback.");
  }
  let http: Partial<NodeHttpModule>;
  try {
    http = requireFn("http") as Partial<NodeHttpModule>;
  } catch {
    throw new Error("MCP OAuth sign-in requires Obsidian desktop so Agentic Chat can open a localhost callback.");
  }
  if (typeof http.createServer !== "function") {
    throw new Error("Could not load Node HTTP support for MCP OAuth callback handling.");
  }
  return http as NodeHttpModule;
}

async function openAuthorizationUrl(url: string): Promise<void> {
  console.warn("Agentic Chat MCP OAuth browser opener: trying OS default browser.", url);
  if (await tryOpenWithWindowsDefaultBrowserFromWsl(url)) return;
  if (await tryOpenWithPlatformBrowser(url)) return;
  const shell = optionalElectronShell();
  if (shell) {
    try {
      console.warn("Agentic Chat MCP OAuth browser opener: trying Electron shell.openExternal.");
      await shell.openExternal(url);
      console.warn("Agentic Chat MCP OAuth browser opener: Electron shell.openExternal returned success.");
      return;
    } catch (error) {
      console.warn(
        `Agentic Chat MCP OAuth browser opener: Electron shell.openExternal failed: ${errorMessage(error)}.`,
      );
    }
  }
  console.warn("Agentic Chat MCP OAuth browser opener: trying window.open.");
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    throw new Error("Could not open the MCP OAuth authorization URL in a browser.");
  }
  console.warn("Agentic Chat MCP OAuth browser opener: window.open returned a window handle.");
}

function optionalNodeRequire(): ((moduleName: string) => unknown) | undefined {
  const candidate = (window as unknown as { require?: (moduleName: string) => unknown }).require;
  if (typeof candidate === "function") return candidate;
  return typeof require === "function" ? require : undefined;
}

function optionalElectronShell(): ElectronShell | null {
  const requireFn = optionalNodeRequire();
  if (!requireFn) return null;
  try {
    const electron = requireFn("electron") as Partial<ElectronModule>;
    const shell = electron.shell;
    return shell && typeof shell.openExternal === "function" ? shell : null;
  } catch {
    return null;
  }
}

async function tryOpenWithWindowsDefaultBrowserFromWsl(url: string): Promise<boolean> {
  const processLike = optionalNodeProcess();
  if (
    processLike?.platform !== "linux" ||
    (!processLike.env?.WSL_DISTRO_NAME && !processLike.env?.WSL_INTEROP)
  ) {
    return false;
  }
  return (
    (await tryExecFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], "WSL Windows ShellExecute")) ||
    (await tryExecFile("explorer.exe", [url], "WSL explorer.exe")) ||
    (await tryExecFile("wslview", [url], "wslview"))
  );
}

async function tryOpenWithPlatformBrowser(url: string): Promise<boolean> {
  const processLike = optionalNodeProcess();
  if (!processLike) return false;
  if (processLike.platform === "win32") {
    return (
      (await tryExecFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], "Windows ShellExecute")) ||
      (await tryExecFile("explorer.exe", [url], "Windows explorer.exe")) ||
      (await tryExecFile("cmd.exe", ["/c", `start "" "${url.replace(/"/g, "%22")}"`], "Windows cmd.exe start"))
    );
  }
  if (processLike.platform === "darwin") return tryExecFile("open", [url], "macOS open");
  if (processLike.platform === "linux") return tryExecFile("xdg-open", [url], "Linux xdg-open");
  return false;
}

async function tryExecFile(command: string, args: string[], label: string): Promise<boolean> {
  const requireFn = optionalNodeRequire();
  if (!requireFn) return false;
  try {
    const childProcess = requireFn("child_process") as Partial<NodeChildProcessModule>;
    if (typeof childProcess.execFile !== "function") return false;
    console.warn(`Agentic Chat MCP OAuth browser opener: trying ${label}.`);
    return await new Promise<boolean>((resolve) => {
      childProcess.execFile?.(command, args, { windowsHide: true }, (error) => {
        if (error) {
          console.warn(`Agentic Chat MCP OAuth browser opener: ${label} failed: ${errorMessage(error)}.`);
          resolve(false);
          return;
        }
        console.warn(`Agentic Chat MCP OAuth browser opener: ${label} returned success.`);
        resolve(true);
      });
    });
  } catch (error) {
    console.warn(`Agentic Chat MCP OAuth browser opener: ${label} threw: ${errorMessage(error)}.`);
    return false;
  }
}

function optionalNodeProcess(): NodeProcessLike | undefined {
  return typeof process !== "undefined" ? process : undefined;
}

async function fetchJson<T>(
  fetcher: WebFetcher,
  url: string,
  label: string,
  requestTimeoutMs: number,
): Promise<T> {
  const response = await fetchWithMcpTimeout(
    fetcher,
    { url, method: "GET", headers: { Accept: "application/json" } },
    label,
    undefined,
    requestTimeoutMs,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label} request failed (HTTP ${response.status}).`);
  }
  return parseJsonObject<T>(response.text, label);
}

function parseJsonObject<T>(text: string, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} was not a JSON object.`);
  }
  return parsed as T;
}

function scopeFromProtectedResource(metadata: OAuthProtectedResourceMetadata): string {
  return stringArray(metadata.scopes_supported).join(" ");
}

function firstString(value: unknown): string {
  if (Array.isArray(value)) return stringValue(value.find((item) => typeof item === "string"));
  return stringValue(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finitePositiveNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeHttpsUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error(`Invalid MCP OAuth URL: ${input}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`MCP OAuth URLs must use https: ${input}`);
  return parsed;
}

function normalizeAdvertisedResourceMetadataUrl(input: string, serverUrl: string): URL {
  const advertised = normalizeHttpsUrl(input);
  advertised.hash = "";
  const resource = normalizeHttpsUrl(serverUrl);
  if (advertised.origin !== resource.origin) {
    throw new Error("MCP OAuth resource metadata must be advertised from the MCP server origin.");
  }
  return advertised;
}

interface NodeHttpModule {
  createServer(handler: (request: NodeIncomingMessage, response: NodeServerResponse) => void): NodeHttpServer;
}

interface NodeIncomingMessage {
  url?: string;
}

interface NodeServerResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

interface NodeHttpServer {
  listen(port: number, hostname: string, callback: () => void): void;
  close(callback?: () => void): void;
  address(): { port: number } | string | null;
  on(event: "error", callback: (error: Error) => void): void;
}

interface ElectronModule {
  shell?: ElectronShell;
}

interface ElectronShell {
  openExternal(url: string): Promise<void> | void;
}

interface NodeChildProcessModule {
  execFile(
    command: string,
    args: string[],
    options: { windowsHide?: boolean },
    callback: (error: Error | null) => void,
  ): unknown;
}

interface NodeProcessLike {
  platform?: string;
  env?: Record<string, string | undefined>;
}

export type { OAuthTokenResponse };
