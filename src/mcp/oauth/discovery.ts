import type { WebFetcher } from "../../tools/web-fetch";
import { fetchWithMcpTimeout } from "../http";
// Spelled via ../../mcp so the settings-tab import guard does not misfire.
import type { McpServerSettings } from "../../mcp/settings";
import type {
  AuthChallenge,
  OAuthAuthorizationServerMetadata,
  OAuthDiscovery,
  OAuthProtectedResourceMetadata,
} from "./types";
import { firstString, normalizeHttpsUrl, parseJsonObject, stringArray, stringValue } from "./values";
import { parseWwwAuthenticate } from "./www-authenticate";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const ACCEPT = "application/json, text/event-stream";

export async function discoverOAuth(
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

export function assertPkceSupported(metadata: OAuthAuthorizationServerMetadata): void {
  const methods = stringArray(metadata.code_challenge_methods_supported);
  if (!methods.includes("S256")) {
    throw new Error("MCP OAuth authorization server does not advertise PKCE S256 support.");
  }
  if (!stringValue(metadata.authorization_endpoint) || !stringValue(metadata.token_endpoint)) {
    throw new Error("MCP OAuth authorization server metadata is missing authorization or token endpoints.");
  }
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

export function scopeFromProtectedResource(metadata: OAuthProtectedResourceMetadata): string {
  return stringArray(metadata.scopes_supported).join(" ");
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
