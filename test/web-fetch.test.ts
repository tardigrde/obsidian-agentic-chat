import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createWebFetchTool,
  extractReadableText,
  normalizeWebUrl,
  type WebFetcher,
  type WebHttpRequest,
  type WebHttpResponse,
} from "../src/tools/web-fetch";

function stubFetcher(
  response: Partial<WebHttpResponse>,
  onRequest?: (request: WebHttpRequest) => void,
): WebFetcher {
  return async (request) => {
    onRequest?.(request);
    return { status: 200, text: "", headers: {}, ...response };
  };
}

async function run(tool: AgentTool, params: unknown): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await tool.execute("call-1", params as never);
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return { text, details: (result.details ?? {}) as Record<string, unknown> };
}

describe("extractReadableText", () => {
  it("pulls the title and strips scripts, styles, and markup", () => {
    const html = `<!doctype html><html><head><title>Hello &amp; World</title>
      <style>.a{color:red}</style><script>alert(1)</script></head>
      <body><h1>Heading</h1><p>First para.</p><p>Second &mdash; para.</p></body></html>`;
    const { title, text } = extractReadableText(html);
    expect(title).toBe("Hello & World");
    expect(text).toContain("Heading");
    expect(text).toContain("First para.");
    expect(text).toContain("Second — para.");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });

  it("decodes numeric and hex entities and collapses whitespace", () => {
    const { text } = extractReadableText("<p>A&#65;&#x42;   spaced\t\tout</p>");
    expect(text).toBe("AAB spaced out");
  });
});

describe("normalizeWebUrl", () => {
  it("accepts http and https URLs", () => {
    expect(normalizeWebUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(normalizeWebUrl(" http://example.com ")).toBe("http://example.com/");
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => normalizeWebUrl("file:///etc/passwd")).toThrow(/http/i);
    expect(() => normalizeWebUrl("ftp://example.com")).toThrow(/http/i);
    expect(() => normalizeWebUrl("not a url")).toThrow(/Invalid URL/i);
  });

  it("blocks localhost and private/link-local addresses (SSRF defense)", () => {
    for (const url of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://172.16.0.1/x",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/x",
    ]) {
      expect(() => normalizeWebUrl(url), url).toThrow(/local or private/i);
    }
  });

  it("blocks IPv4-mapped IPv6 addresses (the parser normalizes these to hex)", () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]/x",
      "http://[::ffff:169.254.169.254]/x",
      "http://[::ffff:10.0.0.1]/x",
      "http://[0:0:0:0:0:ffff:c0a8:0101]/x", // ::ffff:192.168.1.1
    ]) {
      expect(() => normalizeWebUrl(url), url).toThrow(/local or private/i);
    }
  });

  it("still allows IPv4-mapped IPv6 of a public address", () => {
    expect(() => normalizeWebUrl("http://[::ffff:8.8.8.8]/x")).not.toThrow();
  });
});

describe("fetch_url tool", () => {
  it("returns readable text with a source header for HTML pages", async () => {
    const tool = createWebFetchTool({
      fetcher: stubFetcher({
        text: "<html><head><title>Doc</title></head><body><p>Body text.</p></body></html>",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      charLimit: 10_000,
    });
    const { text, details } = await run(tool, { url: "https://example.com/doc" });
    expect(text).toContain("# Doc");
    expect(text).toContain("Source: https://example.com/doc");
    expect(text).toContain("Body text.");
    expect(details.title).toBe("Doc");
    expect(details.truncated).toBe(false);
  });

  it("passes non-HTML text through unchanged", async () => {
    const tool = createWebFetchTool({
      fetcher: stubFetcher({ text: '{"ok":true}', headers: { "content-type": "application/json" } }),
      charLimit: 10_000,
    });
    const { text } = await run(tool, { url: "https://api.example.com/data" });
    expect(text).toContain('{"ok":true}');
  });

  it("truncates to the character limit and notes it", async () => {
    const body = "x".repeat(5_000);
    const tool = createWebFetchTool({
      fetcher: stubFetcher({ text: body, headers: { "content-type": "text/plain" } }),
      charLimit: 600,
    });
    const { text, details } = await run(tool, { url: "https://example.com/big" });
    expect(details.truncated).toBe(true);
    expect(text).toContain("truncated at 600 characters");
  });

  it("requests the normalized URL via the injected fetcher", async () => {
    let seen: WebHttpRequest | undefined;
    const tool = createWebFetchTool({
      fetcher: stubFetcher({ text: "<p>hi</p>", headers: { "content-type": "text/html" } }, (req) => {
        seen = req;
      }),
      charLimit: 10_000,
    });
    await run(tool, { url: "https://example.com/page" });
    expect(seen?.url).toBe("https://example.com/page");
    expect(seen?.method).toBe("GET");
  });

  it("errors on a non-2xx response", async () => {
    const tool = createWebFetchTool({ fetcher: stubFetcher({ status: 404, text: "nope" }), charLimit: 10_000 });
    await expect(run(tool, { url: "https://example.com/missing" })).rejects.toThrow(/HTTP 404/);
  });

  it("surfaces a network/DNS error (status 0) with its message", async () => {
    const tool = createWebFetchTool({
      fetcher: stubFetcher({ status: 0, text: "getaddrinfo ENOTFOUND example.com" }),
      charLimit: 10_000,
    });
    await expect(run(tool, { url: "https://example.com/x" })).rejects.toThrow(/ENOTFOUND/);
  });

  it("skips binary content instead of dumping it", async () => {
    const tool = createWebFetchTool({
      fetcher: stubFetcher({ text: "\x89PNG\r\n\x1a\n…binary…", headers: { "content-type": "image/png" } }),
      charLimit: 10_000,
    });
    const { text } = await run(tool, { url: "https://example.com/logo.png" });
    expect(text).toContain("not text");
    expect(text).not.toContain("PNG");
  });

  it("clips an oversized page before extracting and flags truncation", async () => {
    const huge = `<p>${"a".repeat(600_000)}</p>`;
    const tool = createWebFetchTool({
      fetcher: stubFetcher({ text: huge, headers: { "content-type": "text/html" } }),
      charLimit: 50_000,
    });
    const { text, details } = await run(tool, { url: "https://example.com/huge" });
    expect(details.truncated).toBe(true);
    expect(text.length).toBeLessThan(60_000);
  });

  it("refuses to fetch a blocked host before issuing a request", async () => {
    let called = false;
    const tool = createWebFetchTool({
      fetcher: stubFetcher({ text: "" }, () => {
        called = true;
      }),
      charLimit: 10_000,
    });
    await expect(run(tool, { url: "http://localhost:8080/admin" })).rejects.toThrow(/local or private/i);
    expect(called).toBe(false);
  });
});
