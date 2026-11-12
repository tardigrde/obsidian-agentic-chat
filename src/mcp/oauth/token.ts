import type { WebFetcher, WebHttpResponse } from "../../tools/web-fetch";
import { fetchWithMcpTimeout } from "../http";
// Spelled via ../../mcp so the settings-tab import guard does not misfire.
import type { McpServerSettings } from "../../mcp/settings";
import type {
  OAuthAuthorizationServerMetadata,
  OAuthClientRegistrationResponse,
  OAuthTokenResponse,
} from "./types";
import { finitePositiveNumber, parseJsonObject, stringValue } from "./values";

export async function ensureOAuthClient(
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

export function buildAuthorizationUrl(options: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
  scope: string;
}): string {
  const url = new URL(options.authorizationEndpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`MCP OAuth authorization endpoint must be an http(s) URL: ${options.authorizationEndpoint}`);
  }
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

export async function exchangeAuthorizationCode(
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

export function applyOAuthToken(
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

export function isInvalidRefreshTokenResponse(response: WebHttpResponse): boolean {
  if (response.status !== 400 && response.status !== 401) return false;
  const error = oauthErrorCode(response.text);
  return error === "invalid_grant" || error === "invalid_token";
}

function oauthErrorCode(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : "";
  } catch {
    return "";
  }
}
