import { describe, expect, it } from "vitest";
import { parseRawHttpResponse, shouldProxyMcpRequest } from "../src/mcp/fetcher";
import { assertValidHttpHeaderName, assertValidHttpHeaderValue } from "../src/mcp/http-headers";

describe("MCP proxy fetcher", () => {
  it("uses an HTTP proxy for HTTPS MCP requests unless no_proxy matches", () => {
    expect(
      shouldProxyMcpRequest(
        "https://team-docs.example.com/mcp",
        "http://10.36.148.11:3128/",
        "localhost,127.0.0.1",
      ),
    ).toBe(true);
    expect(
      shouldProxyMcpRequest(
        "https://team-docs.example.com/mcp",
        "http://10.36.148.11:3128/",
        "*.example.com",
      ),
    ).toBe(false);
    expect(
      shouldProxyMcpRequest("http://mcp.example.com/mcp", "http://10.36.148.11:3128/", ""),
    ).toBe(false);
    expect(
      shouldProxyMcpRequest("https://mcp.example.com/mcp", "socks://proxy.example.com:1080", ""),
    ).toBe(false);
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
    expect(JSON.parse(response.text)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { text: "árvíztűrő tükörfúrógép" },
    });
  });

  it("reports content-length truncation before JSON parsing sees partial data", () => {
    const raw = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{\"partial\":");

    expect(() => parseRawHttpResponse(raw)).toThrow(/ended early/);
  });

  it("rejects raw header injection characters", () => {
    expect(assertValidHttpHeaderName("X-API-Key")).toBe("X-API-Key");
    expect(() => assertValidHttpHeaderName("X-API-Key\r\nInjected")).toThrow(/header names/i);
    expect(() => assertValidHttpHeaderValue("secret\r\nInjected: yes")).toThrow(/line breaks/i);
  });
});
