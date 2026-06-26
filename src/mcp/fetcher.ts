import type { WebFetcher, WebHttpRequest, WebHttpResponse } from "../tools/web-fetch";
import { createObsidianFetcher } from "../tools/web-fetch";
import { assertValidHttpHeaderName, assertValidHttpHeaderValue } from "./http-headers";

const DEFAULT_HTTPS_PORT = 443;
const DEFAULT_HTTP_PORT = 80;

export interface ProxyFetchSettings {
  proxyUrl: string;
  noProxy: string;
}

export function createMcpFetcher(settings: ProxyFetchSettings, fallback: WebFetcher = createObsidianFetcher()): WebFetcher {
  return createProxiedFetcher(settings, fallback);
}

export function createProxiedFetcher(
  settings: ProxyFetchSettings,
  fallback: WebFetcher = createObsidianFetcher(),
): WebFetcher {
  const proxyUrl = settings.proxyUrl.trim();
  if (!proxyUrl) return fallback;
  return async (request, signal) => {
    if (!shouldProxyMcpRequest(request.url, proxyUrl, settings.noProxy)) return fallback(request, signal);
    return fetchHttpsViaHttpProxy(request, proxyUrl, signal);
  };
}

export function createDynamicProxiedFetcher(
  getSettings: () => ProxyFetchSettings,
  fallback: WebFetcher = createObsidianFetcher(),
): WebFetcher {
  return async (request, signal) => createProxiedFetcher(getSettings(), fallback)(request, signal);
}

export function createFetchFromWebFetcher(fetcher: WebFetcher): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = headersFromFetchInit(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const response = await fetcher(
      {
        url: typeof input === "string" || input instanceof URL ? input.toString() : input.url,
        method: init?.method === "POST" ? "POST" : "GET",
        headers,
        body,
      },
      init?.signal ?? undefined,
    );
    return new Response(response.text, {
      status: response.status || 599,
      headers: response.headers,
    });
  }) as typeof fetch;
}

export function shouldProxyMcpRequest(requestUrl: string, proxyUrl: string, noProxy: string): boolean {
  let parsed: URL;
  let proxy: URL;
  try {
    parsed = new URL(requestUrl);
    proxy = new URL(proxyUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || proxy.protocol !== "http:") return false;
  return !matchesNoProxy(parsed, noProxy);
}

async function fetchHttpsViaHttpProxy(
  request: WebHttpRequest,
  proxyUrl: string,
  signal?: AbortSignal,
): Promise<WebHttpResponse> {
  const requireFn = optionalNodeRequire();
  if (!requireFn) {
    return {
      status: 0,
      text: "MCP proxy support requires Obsidian desktop with Node networking available.",
      headers: {},
    };
  }
  let net: Partial<NodeNetModule>;
  let tls: Partial<NodeTlsModule>;
  try {
    net = requireFn("net") as Partial<NodeNetModule>;
    tls = requireFn("tls") as Partial<NodeTlsModule>;
  } catch {
    return {
      status: 0,
      text: "Plugin proxy support requires Obsidian desktop with Node networking available.",
      headers: {},
    };
  }
  if (typeof net.connect !== "function" || typeof tls.connect !== "function") {
    return {
      status: 0,
      text: "Plugin proxy support could not load Node net/tls modules.",
      headers: {},
    };
  }

  let target: URL;
  let proxy: URL;
  try {
    target = new URL(request.url);
    proxy = new URL(proxyUrl);
  } catch (error) {
    return { status: 0, text: errorMessage(error), headers: {} };
  }

  const proxySocket = net.connect(proxyPort(proxy), proxy.hostname);
  try {
    await waitForConnect(proxySocket, signal);
    await establishProxyTunnel(proxySocket, target, proxy, signal);
    const secureSocket = tls.connect({
      socket: proxySocket,
      servername: target.hostname,
    });
    await waitForConnect(secureSocket, signal);
    const rawResponse = await writeHttpsRequest(secureSocket, target, request, signal);
    return parseRawHttpResponse(rawResponse);
  } catch (error) {
    destroySocket(proxySocket);
    return { status: 0, text: `MCP proxy request failed: ${errorMessage(error)}`, headers: {} };
  }
}

function waitForConnect(socket: NodeSocket, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted."));
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off?.("connect", onConnect);
      socket.off?.("secureConnect", onSecureConnect);
      socket.off?.("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onSecureConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      destroySocket(socket);
      reject(new Error("Aborted."));
    };
    socket.once?.("connect", onConnect);
    socket.once?.("secureConnect", onSecureConnect);
    socket.once?.("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function establishProxyTunnel(
  socket: NodeSocket,
  target: URL,
  proxy: URL,
  signal?: AbortSignal,
): Promise<void> {
  const targetPort = target.port || String(DEFAULT_HTTPS_PORT);
  const headers = [
    `CONNECT ${target.hostname}:${targetPort} HTTP/1.1`,
    `Host: ${target.hostname}:${targetPort}`,
    "Proxy-Connection: keep-alive",
  ];
  const authorization = proxyAuthorization(proxy);
  if (authorization) headers.push(`Proxy-Authorization: ${authorization}`);
  socket.write(`${headers.join("\r\n")}\r\n\r\n`);
  const response = await readUntilHeaders(socket, signal);
  const status = /^HTTP\/\S+\s+(\d+)/i.exec(response)?.[1];
  if (status !== "200") {
    throw new Error(`proxy CONNECT failed (${status ? `HTTP ${status}` : "invalid response"}).`);
  }
}

function writeHttpsRequest(
  socket: NodeSocket,
  target: URL,
  request: WebHttpRequest,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted."));
  const body = request.body ?? "";
  const method = request.method ?? "GET";
  const path = `${target.pathname || "/"}${target.search}`;
  const headers = new Map<string, string>();
  headers.set("host", target.host);
  headers.set("connection", "close");
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (key.toLowerCase() === "host" || key.toLowerCase() === "connection") continue;
    headers.set(assertValidHttpHeaderName(key).toLowerCase(), assertValidHttpHeaderValue(value));
  }
  if (body) headers.set("content-length", String(Buffer.byteLength(body)));
  const headerLines = [...headers.entries()].map(([key, value]) => `${headerName(key)}: ${value}`);
  socket.write(`${method} ${path} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n${body}`);
  return readUntilEnd(socket, signal);
}

function readUntilHeaders(socket: NodeSocket, signal?: AbortSignal): Promise<string> {
  return readFromSocket(socket, (text) => text.includes("\r\n\r\n"), signal);
}

function readUntilEnd(socket: NodeSocket, signal?: AbortSignal): Promise<Buffer> {
  return readBufferFromSocket(socket, signal);
}

function readFromSocket(
  socket: NodeSocket,
  done: (text: string) => boolean,
  signal?: AbortSignal,
  waitForEnd = false,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted."));
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const cleanup = (): void => {
      socket.off?.("data", onData);
      socket.off?.("end", onEnd);
      socket.off?.("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const currentText = (): string => Buffer.concat(chunks).toString("utf8");
    const onData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (!waitForEnd && done(currentText())) {
        cleanup();
        resolve(currentText());
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(currentText());
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      destroySocket(socket);
      reject(new Error("Aborted."));
    };
    socket.on?.("data", onData);
    socket.once?.("end", onEnd);
    socket.once?.("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function readBufferFromSocket(socket: NodeSocket, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted."));
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const cleanup = (): void => {
      socket.off?.("data", onData);
      socket.off?.("end", onEnd);
      socket.off?.("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      destroySocket(socket);
      reject(new Error("Aborted."));
    };
    socket.on?.("data", onData);
    socket.once?.("end", onEnd);
    socket.once?.("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseRawHttpResponse(raw: Buffer): WebHttpResponse {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator < 0) throw new Error("proxy response did not include HTTP headers.");
  const headerText = raw.subarray(0, separator).toString("latin1");
  const body = raw.subarray(separator + 4);
  const lines = headerText.split("\r\n");
  const status = Number.parseInt(/^HTTP\/\S+\s+(\d+)/i.exec(lines[0] ?? "")?.[1] ?? "0", 10);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  const bodyBytes = /chunked/i.test(headers["transfer-encoding"] ?? "")
    ? decodeChunkedBody(body)
    : bodyFromContentLength(body, headers["content-length"]);
  const text = bodyBytes.toString("utf8");
  return { status, text, headers };
}

function decodeChunkedBody(input: Buffer): Buffer {
  let offset = 0;
  const chunks: Buffer[] = [];
  while (offset < input.length) {
    const lineEnd = indexOfCrlf(input, offset);
    if (lineEnd < 0) throw new Error("proxy response ended inside a chunk header.");
    const sizeText = input.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error("proxy response included an invalid chunk size.");
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks);
    if (offset + size > input.length) throw new Error("proxy response body ended inside a chunk.");
    chunks.push(input.subarray(offset, offset + size));
    offset += size;
    if (input[offset] === 13 && input[offset + 1] === 10) offset += 2;
  }
  throw new Error("proxy response ended before the terminating chunk.");
}

function bodyFromContentLength(body: Buffer, contentLength: string | undefined): Buffer {
  if (!contentLength) return body;
  const expected = Number.parseInt(contentLength, 10);
  if (!Number.isFinite(expected) || expected < 0) return body;
  if (body.length < expected) {
    throw new Error(`proxy response body ended early (${body.length}/${expected} bytes).`);
  }
  return body.subarray(0, expected);
}

function indexOfCrlf(input: Buffer, start: number): number {
  for (let index = start; index + 1 < input.length; index += 1) {
    if (input[index] === 13 && input[index + 1] === 10) return index;
  }
  return -1;
}

function matchesNoProxy(url: URL, noProxy: string): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const hostPort = `${host}:${url.port || DEFAULT_HTTPS_PORT}`;
  for (const raw of noProxy.split(/[,\s]+/)) {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === "*") return true;
    if (pattern === host || pattern === hostPort) return true;
    if (pattern.startsWith(".") && host.endsWith(pattern)) return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      if (host.endsWith(suffix)) return true;
    }
  }
  return false;
}

function proxyPort(proxy: URL): number {
  if (proxy.port) return Number.parseInt(proxy.port, 10);
  return proxy.protocol === "http:" ? DEFAULT_HTTP_PORT : DEFAULT_HTTPS_PORT;
}

function proxyAuthorization(proxy: URL): string {
  if (!proxy.username && !proxy.password) return "";
  return `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
}

function headerName(key: string): string {
  return key
    .split("-")
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
    .join("-");
}

function optionalNodeRequire(): ((moduleName: string) => unknown) | undefined {
  const candidate = (window as unknown as { require?: (moduleName: string) => unknown }).require;
  if (typeof candidate === "function") return candidate;
  return typeof require === "function" ? require : undefined;
}

function destroySocket(socket: NodeSocket): void {
  socket.destroy?.();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function headersFromFetchInit(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  return { ...headers };
}

interface NodeNetModule {
  connect(port: number, host: string): NodeSocket;
}

interface NodeTlsModule {
  connect(options: { socket: NodeSocket; servername: string }): NodeSocket;
}

interface NodeSocket {
  write(data: string): void;
  destroy?(): void;
  on?(event: "data", callback: (chunk: Buffer | string) => void): void;
  on?(event: "error", callback: (error: Error) => void): void;
  once?(event: "connect" | "secureConnect" | "end", callback: () => void): void;
  once?(event: "error", callback: (error: Error) => void): void;
  off?(event: "connect" | "secureConnect" | "end", callback: () => void): void;
  off?(event: "data", callback: (chunk: Buffer | string) => void): void;
  off?(event: "error", callback: (error: Error) => void): void;
}
