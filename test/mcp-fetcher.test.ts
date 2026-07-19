import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDynamicProxiedFetcher,
  createFetchFromWebFetcher,
  createMcpFetcher,
  createProxiedFetcher,
  parseRawHttpResponse,
  shouldProxyMcpRequest,
  type ProxyFetchSettings,
} from "../src/mcp/fetcher";
import type { WebFetcher, WebHttpRequest } from "../src/tools/web-fetch";
import { assertValidHttpHeaderName, assertValidHttpHeaderValue } from "../src/mcp/http-headers";

describe("MCP proxy fetcher", () => {
  it("uses an HTTP proxy for HTTPS MCP requests unless no_proxy matches", () => {
    expect(
      shouldProxyMcpRequest(
        "https://team-docs.example.com/mcp",
        "http://192.0.2.10:3128/",
        "localhost,127.0.0.1",
      ),
    ).toBe(true);
    expect(
      shouldProxyMcpRequest(
        "https://team-docs.example.com/mcp",
        "http://192.0.2.10:3128/",
        "*.example.com",
      ),
    ).toBe(false);
    expect(
      shouldProxyMcpRequest("http://mcp.example.com/mcp", "http://192.0.2.10:3128/", ""),
    ).toBe(false);
    expect(
      shouldProxyMcpRequest("https://mcp.example.com/mcp", "socks://proxy.example.com:1080", ""),
    ).toBe(false);
  });

  it("returns false when either URL fails to parse", () => {
    expect(shouldProxyMcpRequest("not a url", "http://192.0.2.10:3128/", "")).toBe(false);
    expect(shouldProxyMcpRequest("https://mcp.example.com/mcp", "not a url", "")).toBe(false);
  });

  it("honors a variety of no_proxy patterns", () => {
    const proxy = "http://192.0.2.10:3128/";
    // Exact host match.
    expect(shouldProxyMcpRequest("https://host.example.com/mcp", proxy, "host.example.com")).toBe(false);
    // host:port match uses the default HTTPS port when none is given.
    expect(shouldProxyMcpRequest("https://host.example.com/mcp", proxy, "host.example.com:443")).toBe(false);
    // A leading-dot suffix matches subdomains.
    expect(shouldProxyMcpRequest("https://api.example.com/mcp", proxy, ".example.com")).toBe(false);
    // A bare wildcard in no_proxy bypasses the proxy for everything.
    expect(shouldProxyMcpRequest("https://anything.test/mcp", proxy, "*")).toBe(false);
    // Whitespace-separated entries and blank entries are ignored gracefully.
    expect(shouldProxyMcpRequest("https://keep.example.com/mcp", proxy, "  , other.test ")).toBe(true);
  });

  it("decodes chunked proxy responses by byte length before UTF-8 text decoding", () => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "árvíztűrő tükörfúrógép" } }));
    const raw = Buffer.concat([
      Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n"),
      Buffer.from(`${body.length.toString(16)}\r\n`),
      body,
      Buffer.from("\r\n0\r\n\r\n"),
    ]);

    const response = parseRawHttpResponse(raw);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(response.text)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { text: "árvíztűrő tükörfúrógép" },
    });
  });

  it("returns the plain body when there is no content-length or transfer-encoding", () => {
    const raw = Buffer.from("HTTP/1.1 204 No Content\r\nX-Trace: abc\r\n\r\nhello world");
    const response = parseRawHttpResponse(raw);
    expect(response.status).toBe(204);
    expect(response.headers["x-trace"]).toBe("abc");
    expect(response.text).toBe("hello world");
  });

  it("truncates the body to content-length when the socket over-reads", () => {
    const raw = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello trailing junk");
    expect(parseRawHttpResponse(raw).text).toBe("hello");
  });

  it("reports content-length truncation before JSON parsing sees partial data", () => {
    const raw = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{\"partial\":");

    expect(() => parseRawHttpResponse(raw)).toThrow(/ended early/);
  });

  it("throws when the raw response has no header separator", () => {
    expect(() => parseRawHttpResponse(Buffer.from("HTTP/1.1 200 OK"))).toThrow(/HTTP headers/);
  });

  it("throws on malformed chunk sizes and truncated chunk bodies", () => {
    const invalidSize = Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nab\r\n0\r\n\r\n");
    expect(() => parseRawHttpResponse(invalidSize)).toThrow(/invalid chunk size/);

    const truncatedChunk = Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\nshort");
    expect(() => parseRawHttpResponse(truncatedChunk)).toThrow(/ended inside a chunk/);
  });

  it("rejects raw header injection characters", () => {
    expect(assertValidHttpHeaderName("X-API-Key")).toBe("X-API-Key");
    expect(() => assertValidHttpHeaderName("X-API-Key\r\nInjected")).toThrow(/header names/i);
    expect(() => assertValidHttpHeaderValue("secret\r\nInjected: yes")).toThrow(/line breaks/i);
  });
});

describe("createProxiedFetcher", () => {
  it("returns the fallback unchanged when no proxy is configured", async () => {
    const fallback = vi.fn<WebFetcher>(async () => ({ status: 200, text: "direct", headers: {} }));
    const fetcher = createProxiedFetcher({ proxyUrl: "  ", noProxy: "" }, fallback);
    expect(fetcher).toBe(fallback);
  });

  it("delegates non-proxied requests to the fallback", async () => {
    const fallback = vi.fn<WebFetcher>(async () => ({ status: 200, text: "direct", headers: {} }));
    const fetcher = createProxiedFetcher({ proxyUrl: "http://192.0.2.10:3128", noProxy: "" }, fallback);

    // Plain HTTP requests are never tunneled through the HTTP CONNECT proxy.
    const response = await fetcher({ url: "http://plain.example.com/mcp" });

    expect(response.text).toBe("direct");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("delegates no_proxy matches to the fallback", async () => {
    const fallback = vi.fn<WebFetcher>(async () => ({ status: 200, text: "direct", headers: {} }));
    const fetcher = createProxiedFetcher(
      { proxyUrl: "http://192.0.2.10:3128", noProxy: "*.example.com" },
      fallback,
    );

    await fetcher({ url: "https://api.example.com/mcp" });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("createMcpFetcher is an alias for createProxiedFetcher", () => {
    const fallback = vi.fn<WebFetcher>(async () => ({ status: 200, text: "", headers: {} }));
    expect(createMcpFetcher({ proxyUrl: "", noProxy: "" }, fallback)).toBe(fallback);
  });
});

describe("createDynamicProxiedFetcher", () => {
  it("re-reads settings on every request", async () => {
    const fallback = vi.fn<WebFetcher>(async () => ({ status: 200, text: "direct", headers: {} }));
    let settings: ProxyFetchSettings = { proxyUrl: "", noProxy: "" };
    const fetcher = createDynamicProxiedFetcher(() => settings, fallback);

    await fetcher({ url: "https://mcp.example.com/mcp" });
    expect(fallback).toHaveBeenCalledTimes(1);

    // Later the proxy is disabled for this host; the fetcher must still route direct.
    settings = { proxyUrl: "http://192.0.2.10:3128", noProxy: "mcp.example.com" };
    await fetcher({ url: "https://mcp.example.com/mcp" });
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});

describe("createFetchFromWebFetcher", () => {
  it("maps a fetch call onto the injected web fetcher and back to a Response", async () => {
    const seen: WebHttpRequest[] = [];
    const fetcher: WebFetcher = async (request) => {
      seen.push(request);
      return { status: 201, text: "created", headers: { "content-type": "text/plain" } };
    };
    const fetchImpl = createFetchFromWebFetcher(fetcher);

    const response = await fetchImpl("https://mcp.example.com/rpc", {
      method: "POST",
      body: JSON.stringify({ hi: true }),
      headers: { "X-Token": "secret" },
    });

    expect(seen[0]).toEqual({
      url: "https://mcp.example.com/rpc",
      method: "POST",
      headers: { "X-Token": "secret" },
      body: JSON.stringify({ hi: true }),
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("created");
    expect(response.headers.get("content-type")).toBe("text/plain");
  });

  it("defaults to GET and coerces a zero status into a synthetic 599", async () => {
    const fetcher: WebFetcher = async () => ({ status: 0, text: "boom", headers: {} });
    const fetchImpl = createFetchFromWebFetcher(fetcher);

    const response = await fetchImpl(new URL("https://mcp.example.com/rpc"));
    expect(response.status).toBe(599);
  });

  it("normalizes Headers and header-array inputs", async () => {
    const seen: WebHttpRequest[] = [];
    const fetcher: WebFetcher = async (request) => {
      seen.push(request);
      return { status: 200, text: "", headers: {} };
    };
    const fetchImpl = createFetchFromWebFetcher(fetcher);

    await fetchImpl("https://mcp.example.com/rpc", { headers: new Headers({ "x-a": "1" }) });
    await fetchImpl("https://mcp.example.com/rpc", { headers: [["x-b", "2"]] });
    await fetchImpl({ url: "https://mcp.example.com/from-request" } as Request);

    expect(seen[0]?.headers).toEqual({ "x-a": "1" });
    expect(seen[1]?.headers).toEqual({ "x-b": "2" });
    expect(seen[2]?.url).toBe("https://mcp.example.com/from-request");
    expect(seen[2]?.headers).toEqual({});
  });
});

class MockSocket extends EventEmitter {
  writes: string[] = [];
  destroyed = false;
  onWrite?: (data: string, socket: MockSocket) => void;

  write(data: string): void {
    this.writes.push(data);
    this.onWrite?.(data, this);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

interface ProxyHarness {
  proxySocket: MockSocket;
  secureSocket: MockSocket;
  restore: () => void;
}

/**
 * Installs fake `net`/`tls` modules on `window.require` so the proxy tunnel path
 * runs end-to-end without real sockets. The proxy socket answers the CONNECT
 * request; the TLS socket answers the tunneled HTTPS request.
 */
function installProxyModules(options: {
  connectResponse?: string;
  httpsResponse?: Buffer | string;
  emitEnd?: boolean;
}): ProxyHarness {
  const proxySocket = new MockSocket();
  const secureSocket = new MockSocket();

  proxySocket.onWrite = (data, socket) => {
    if (data.includes("CONNECT")) {
      setTimeout(() => socket.emit("data", Buffer.from(options.connectResponse ?? "HTTP/1.1 200 Connection established\r\n\r\n")), 0);
    }
  };
  secureSocket.onWrite = (_data, socket) => {
    const payload = options.httpsResponse ?? "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
    setTimeout(() => {
      socket.emit("data", Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
      if (options.emitEnd !== false) socket.emit("end");
    }, 0);
  };

  const net = {
    connect: (_port: number, _host: string) => {
      setTimeout(() => proxySocket.emit("connect"), 0);
      return proxySocket;
    },
  };
  const tls = {
    connect: (_opts: { socket: MockSocket; servername: string }) => {
      setTimeout(() => secureSocket.emit("secureConnect"), 0);
      return secureSocket;
    },
  };

  const holder = window as unknown as { require?: (name: string) => unknown };
  const previous = holder.require;
  holder.require = (name: string) => {
    if (name === "net") return net;
    if (name === "tls") return tls;
    throw new Error(`unexpected module ${name}`);
  };

  return {
    proxySocket,
    secureSocket,
    restore: () => {
      if (previous) holder.require = previous;
      else delete holder.require;
    },
  };
}

describe("fetchHttpsViaHttpProxy (tunnel path)", () => {
  afterEach(() => {
    delete (window as unknown as { require?: unknown }).require;
  });

  it("tunnels an HTTPS request through the proxy and parses the response", async () => {
    const harness = installProxyModules({
      httpsResponse: "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"ok\":true}\r\n",
    });
    const fetcher = createProxiedFetcher({ proxyUrl: "http://user:pass@192.0.2.10:3128", noProxy: "" });

    const response = await fetcher({
      url: "https://mcp.example.com/rpc",
      method: "POST",
      headers: { "X-Token": "secret", host: "ignored", connection: "keep-alive" },
      body: JSON.stringify({ hi: true }),
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.text).toContain("\"ok\":true");

    // The CONNECT preamble carries Basic proxy auth and the target host.
    const connect = harness.proxySocket.writes.join("");
    expect(connect).toContain("CONNECT mcp.example.com:443 HTTP/1.1");
    expect(connect).toContain(`Proxy-Authorization: Basic ${Buffer.from("user:pass").toString("base64")}`);

    // The tunneled request drops hop-by-hop host/connection overrides and adds content-length.
    const request = harness.secureSocket.writes.join("");
    expect(request).toContain("POST /rpc HTTP/1.1");
    expect(request).toContain("Host: mcp.example.com");
    expect(request).toContain("X-Token: secret");
    expect(request).toContain(`Content-Length: ${Buffer.byteLength(JSON.stringify({ hi: true }))}`);
    harness.restore();
  });

  it("surfaces a failed proxy CONNECT as a status-0 error response", async () => {
    installProxyModules({ connectResponse: "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n" });
    const fetcher = createProxiedFetcher({ proxyUrl: "http://192.0.2.10:3128", noProxy: "" });

    const response = await fetcher({ url: "https://mcp.example.com/rpc" });

    expect(response.status).toBe(0);
    expect(response.text).toMatch(/proxy CONNECT failed \(HTTP 407\)/);
    delete (window as unknown as { require?: unknown }).require;
  });

  it("returns a helpful status-0 message when net/tls cannot be loaded", async () => {
    // Modules resolve but lack the connect functions the tunnel needs.
    const holder = window as unknown as { require?: (name: string) => unknown };
    holder.require = () => ({});
    const fetcher = createProxiedFetcher({ proxyUrl: "http://192.0.2.10:3128", noProxy: "" });

    const response = await fetcher({ url: "https://mcp.example.com/rpc" });

    expect(response.status).toBe(0);
    expect(response.text).toMatch(/could not load Node net\/tls modules/);
    delete (window as unknown as { require?: unknown }).require;
  });
});
