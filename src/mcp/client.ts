import type { WebFetcher, WebHttpResponse } from "../tools/web-fetch";
import type { McpServerSettings } from "./settings";
import { parseWwwAuthenticate, refreshMcpOAuthToken, shouldRefreshMcpOAuthToken } from "./oauth";
import { DEFAULT_MCP_HTTP_TIMEOUT_MS, fetchWithMcpTimeout } from "./http";
import { assertValidHttpHeaderName, assertValidHttpHeaderValue } from "./http-headers";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_PROTOCOL_VERSION_FALLBACKS = ["2025-06-18", "2024-11-05"] as const;
const MCP_MAX_SSE_RESUME_ATTEMPTS = 3;
const JSON_RPC = "2.0";
const ACCEPT = "application/json, text/event-stream";

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpCallToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface McpInitializeResult {
  protocolVersion?: string;
  serverInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
}

interface JsonRpcSuccess<T> {
  jsonrpc: typeof JSON_RPC;
  id: number | string | null;
  result: T;
}

interface JsonRpcFailure {
  jsonrpc: typeof JSON_RPC;
  id: number | string | null;
  error: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

interface JsonRpcRequest {
  jsonrpc: typeof JSON_RPC;
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpHttpClientOptions {
  server: McpServerSettings;
  fetcher: WebFetcher;
  onServerChanged?: () => void | Promise<void>;
  requestTimeoutMs?: number;
}

class McpSessionTerminatedError extends Error {}

class McpOAuthUnauthorizedError extends Error {
  constructor(readonly challenge: string) {
    super("MCP OAuth token was rejected.");
  }
}

class McpOAuthForbiddenError extends Error {
  constructor(readonly challenge: string) {
    super("MCP OAuth token was forbidden.");
  }
}

class McpJsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    readonly data: unknown,
    message: string,
  ) {
    super(message);
  }
}

class McpSseResponseIncompleteError extends Error {
  constructor(readonly lastEventId: string | undefined) {
    super("MCP SSE response ended without a matching JSON-RPC result.");
  }
}

export class McpHttpClient {
  private readonly server: McpServerSettings;
  private readonly fetcher: WebFetcher;
  private readonly onServerChanged?: () => void | Promise<void>;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private sessionId: string | undefined;
  private initialized = false;

  constructor(options: McpHttpClientOptions) {
    this.server = options.server;
    this.fetcher = options.fetcher;
    this.onServerChanged = options.onServerChanged;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_MCP_HTTP_TIMEOUT_MS;
  }

  async initialize(signal?: AbortSignal): Promise<McpInitializeResult> {
    let lastProtocolError: unknown;
    for (const protocolVersion of [MCP_PROTOCOL_VERSION, ...MCP_PROTOCOL_VERSION_FALLBACKS]) {
      this.protocolVersion = protocolVersion;
      try {
        const result = await this.request<McpInitializeResult>(
          "initialize",
          {
            protocolVersion,
            capabilities: {},
            clientInfo: {
              name: "obsidian-agentic-chat",
              title: "Agentic Chat",
              version: "0.0.0",
            },
          },
          signal,
        );
        if (typeof result.protocolVersion === "string" && result.protocolVersion.trim()) {
          this.protocolVersion = result.protocolVersion.trim();
        }
        this.initialized = true;
        await this.notify("notifications/initialized", undefined, signal);
        return result;
      } catch (error) {
        if (!isProtocolVersionRejection(error)) throw error;
        lastProtocolError = error;
        this.sessionId = undefined;
        this.initialized = false;
      }
    }
    throw lastProtocolError instanceof Error ? lastProtocolError : new Error("MCP initialize failed.");
  }

  async openEventStream(signal?: AbortSignal): Promise<WebHttpResponse> {
    const response = await this.getSseAfter(undefined, signal);
    if (!/text\/event-stream/i.test(response.headers["content-type"] ?? "")) {
      throw new Error(`MCP ${this.server.name} SSE stream did not return text/event-stream.`);
    }
    return response;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    await this.ensureInitialized(signal);
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request<{ tools?: unknown[]; nextCursor?: string }>(
        "tools/list",
        cursor ? { cursor } : undefined,
        signal,
      );
      tools.push(...parseTools(result.tools));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallToolResult> {
    await this.ensureInitialized(signal);
    return this.request<McpCallToolResult>("tools/call", { name, arguments: args }, signal);
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!this.initialized) await this.initialize(signal);
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.requestOnce(method, params, signal, true);
  }

  private async requestOnce<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    retryOnTerminatedSession: boolean,
  ): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    try {
      const response = await this.post({ jsonrpc: JSON_RPC, id, method, params }, signal);
      const parsed = await this.parseOrResumeResponse<T>(response, id, signal);
      if ("error" in parsed) {
        const message = `MCP ${this.server.name} ${method} failed: ${parsed.error.message ?? "JSON-RPC error"}`;
        throw new McpJsonRpcError(method, parsed.error.code, parsed.error.data, message);
      }
      return parsed.result;
    } catch (error) {
      if (retryOnTerminatedSession && error instanceof McpOAuthUnauthorizedError) {
        const refreshed = await this.refreshOAuthAfterUnauthorized(signal);
        if (refreshed) {
          if (method !== "initialize") await this.initialize(signal);
          return this.requestOnce<T>(method, params, signal, false);
        }
        throw new Error(this.oauthAuthenticationMessage(error.challenge));
      }
      if (retryOnTerminatedSession && error instanceof McpOAuthForbiddenError) {
        const refreshed = await this.refreshOAuthForRequiredScope(error.challenge, signal);
        if (refreshed) {
          if (method !== "initialize") await this.initialize(signal);
          return this.requestOnce<T>(method, params, signal, false);
        }
        throw new Error(this.oauthForbiddenMessage(error.challenge));
      }
      if (retryOnTerminatedSession && method !== "initialize" && error instanceof McpSessionTerminatedError) {
        this.sessionId = undefined;
        this.initialized = false;
        await this.initialize(signal);
        return this.requestOnce<T>(method, params, signal, false);
      }
      throw error;
    }
  }

  private async parseOrResumeResponse<T>(
    response: WebHttpResponse,
    id: number,
    signal: AbortSignal | undefined,
  ): Promise<JsonRpcResponse<T>> {
    let current = response;
    let lastEventId: string | undefined;
    for (let attempt = 0; attempt <= MCP_MAX_SSE_RESUME_ATTEMPTS; attempt += 1) {
      if (current.status === 202) {
        current = await this.getSseAfter(lastEventId, signal);
        continue;
      }
      try {
        return parseJsonRpcResponse<T>(current, id);
      } catch (error) {
        if (!(error instanceof McpSseResponseIncompleteError) || !error.lastEventId) throw error;
        lastEventId = error.lastEventId;
        current = await this.getSseAfter(lastEventId, signal);
      }
    }
    throw new Error(`MCP ${this.server.name} SSE response did not deliver JSON-RPC id ${id}.`);
  }

  private async notify(
    method: string,
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.post({ jsonrpc: JSON_RPC, method, params }, signal);
    } catch (error) {
      if (error instanceof McpOAuthUnauthorizedError) {
        throw new Error(this.oauthAuthenticationMessage(error.challenge));
      }
      throw error;
    }
  }

  private async post(body: JsonRpcRequest, signal?: AbortSignal): Promise<WebHttpResponse> {
    if (signal?.aborted) throw new Error("Aborted.");
    const url = normalizeMcpUrl(this.server.url);
    const response = await fetchWithMcpTimeout(
      this.fetcher,
      {
        url,
        method: "POST",
        headers: await this.headers(signal),
        body: JSON.stringify(body),
      },
      `${this.server.name} ${body.method}`,
      signal,
      this.requestTimeoutMs,
    );
    const sessionId = response.headers["mcp-session-id"];
    if (sessionId) this.sessionId = sessionId;
    if (response.status === 0) {
      throw new Error(`MCP ${this.server.name} request failed: ${response.text || "network error"}.`);
    }
    if (response.status < 200 || response.status >= 300) {
      const auth = response.headers["www-authenticate"];
      const hint = auth ? ` (${auth})` : "";
      if (response.status === 404 && this.sessionId) {
        throw new McpSessionTerminatedError(`MCP ${this.server.name} session expired.`);
      }
      if (response.status === 401 && this.server.authType === "oauth") {
        throw new McpOAuthUnauthorizedError(auth ?? "");
      }
      if (response.status === 403 && this.server.authType === "oauth") {
        throw new McpOAuthForbiddenError(auth ?? "");
      }
      throw new Error(`MCP ${this.server.name} request failed (HTTP ${response.status})${hint}.`);
    }
    return response;
  }

  private async getSseAfter(lastEventId: string | undefined, signal?: AbortSignal): Promise<WebHttpResponse> {
    if (signal?.aborted) throw new Error("Aborted.");
    const headers = await this.headers(signal);
    headers.Accept = "text/event-stream";
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    const response = await fetchWithMcpTimeout(
      this.fetcher,
      {
        url: normalizeMcpUrl(this.server.url),
        method: "GET",
        headers,
      },
      lastEventId ? `${this.server.name} SSE resume` : `${this.server.name} SSE stream`,
      signal,
      this.requestTimeoutMs,
    );
    const sessionId = response.headers["mcp-session-id"];
    if (sessionId) this.sessionId = sessionId;
    if (response.status === 0) {
      throw new Error(`MCP ${this.server.name} SSE resume failed: ${response.text || "network error"}.`);
    }
    if (response.status < 200 || response.status >= 300) {
      const auth = response.headers["www-authenticate"];
      if (response.status === 404 && this.sessionId) {
        throw new McpSessionTerminatedError(`MCP ${this.server.name} session expired.`);
      }
      if (response.status === 401 && this.server.authType === "oauth") {
        throw new McpOAuthUnauthorizedError(auth ?? "");
      }
      if (response.status === 403 && this.server.authType === "oauth") {
        throw new McpOAuthForbiddenError(auth ?? "");
      }
      throw new Error(`MCP ${this.server.name} SSE resume failed (HTTP ${response.status}).`);
    }
    return response;
  }

  private async headers(signal?: AbortSignal): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: ACCEPT,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": this.protocolVersion,
    };
    if (this.sessionId) headers["MCP-Session-Id"] = this.sessionId;
    if (this.server.authType === "header" && this.server.authHeaderName && this.server.authHeaderValue) {
      headers[assertValidHttpHeaderName(this.server.authHeaderName)] = assertValidHttpHeaderValue(
        this.server.authHeaderValue,
      );
    }
    if (this.server.authType === "bearer" && this.server.authHeaderValue) {
      headers.Authorization = assertValidHttpHeaderValue(bearerAuthorizationHeader(this.server.authHeaderValue));
    }
    if (this.server.authType === "oauth") {
      if (shouldRefreshMcpOAuthToken(this.server)) {
        const refreshed = await refreshMcpOAuthToken(
          this.server,
          this.fetcher,
          signal,
          Date.now,
          this.requestTimeoutMs,
        );
        if (refreshed) await this.onServerChanged?.();
      }
      if (this.server.oauth.accessToken) {
        headers.Authorization = assertValidHttpHeaderValue(`Bearer ${this.server.oauth.accessToken}`);
      }
    }
    return headers;
  }

  private async refreshOAuthAfterUnauthorized(signal?: AbortSignal): Promise<boolean> {
    if (this.server.authType !== "oauth") return false;
    const refreshed = await refreshMcpOAuthToken(
      this.server,
      this.fetcher,
      signal,
      Date.now,
      this.requestTimeoutMs,
    );
    if (!refreshed) return false;
    this.sessionId = undefined;
    this.initialized = false;
    await this.onServerChanged?.();
    return true;
  }

  private async refreshOAuthForRequiredScope(challenge: string, signal?: AbortSignal): Promise<boolean> {
    if (this.server.authType !== "oauth") return false;
    const params = challenge ? parseWwwAuthenticate(challenge) : {};
    const requiredScope = params.scope?.trim();
    if (!requiredScope || !/insufficient_scope/i.test(params.error ?? "")) return false;
    const refreshed = await refreshMcpOAuthToken(
      this.server,
      this.fetcher,
      signal,
      Date.now,
      this.requestTimeoutMs,
      requiredScope,
    );
    if (!refreshed) return false;
    this.sessionId = undefined;
    this.initialized = false;
    await this.onServerChanged?.();
    return true;
  }

  private oauthAuthenticationMessage(challenge: string): string {
    const params = challenge ? parseWwwAuthenticate(challenge) : {};
    const detail = params.error_description || params.error;
    return (
      `MCP ${this.server.name} requires OAuth authentication.` +
      (detail ? ` ${detail}.` : "") +
      " Open Agentic Chat settings, authenticate the MCP server, and retry."
    );
  }

  private oauthForbiddenMessage(challenge: string): string {
    const params = challenge ? parseWwwAuthenticate(challenge) : {};
    const scope = params.scope ? ` Required OAuth scopes: ${params.scope}.` : "";
    const detail = params.error_description || params.error;
    return (
      `MCP ${this.server.name} refused the OAuth token (HTTP 403).` +
      (detail ? ` ${detail}.` : "") +
      scope +
      " Re-authenticate the MCP server."
    );
  }
}

function bearerAuthorizationHeader(value: string): string {
  const trimmed = value.trim();
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export function normalizeMcpUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error(`Invalid MCP server URL: ${input}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`MCP server URLs must use https: ${input}`);
  }
  return parsed.toString();
}

function parseTools(value: unknown): McpToolDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const name = asString(record.name).trim();
    if (!name) return [];
    return [
      {
        name,
        title: asString(record.title),
        description: asString(record.description),
        inputSchema: asSchema(record.inputSchema),
        outputSchema: asSchema(record.outputSchema),
        annotations: asRecord(record.annotations),
      },
    ];
  });
}

function parseJsonRpcResponse<T>(response: WebHttpResponse, id: number): JsonRpcResponse<T> {
  const parsed = parseJsonBodyOrSse(response.text, response.headers["content-type"] ?? "", id);
  const record = asRecord(parsed);
  if (record.error && typeof record.error === "object") return record as unknown as JsonRpcFailure;
  if ("result" in record) return record as unknown as JsonRpcSuccess<T>;
  throw new Error("MCP server returned an invalid JSON-RPC response.");
}

function parseJsonBodyOrSse(text: string, contentType: string, id: number): unknown {
  if (!/text\/event-stream/i.test(contentType) && !text.trimStart().startsWith("data:")) {
    return JSON.parse(text || "{}");
  }
  let lastEventId: string | undefined;
  for (const event of text.split(/\r?\n\r?\n+/)) {
    const lines = event.split(/\r?\n/);
    const eventId = lines.find((line) => line.startsWith("id:"))?.slice(3).trimStart();
    if (eventId) lastEventId = eventId;
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) continue;
    const parsed: unknown = JSON.parse(data);
    const record = asRecord(parsed);
    if (record.id === id || record.id === String(id)) return parsed;
  }
  throw new McpSseResponseIncompleteError(lastEventId);
}

function isProtocolVersionRejection(error: unknown): boolean {
  if (!(error instanceof McpJsonRpcError) || error.method !== "initialize") return false;
  const message = error.message.toLowerCase();
  if (error.code === -32602 && /protocol|version/.test(message)) return true;
  return /protocol\s*version|unsupported.*version|unsupported.*protocol/.test(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asSchema(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
