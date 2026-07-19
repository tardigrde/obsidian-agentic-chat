import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolArtifactMetadata, ToolArtifactStoreLike, ToolArtifactWriteInput } from "../src/artifacts/tool-artifact-store";
import { parseSourceReference } from "../src/retrieval/citations";
import {
  createWebFetchTool,
  extractReadableText,
  normalizeWebUrl,
  type WebFetcher,
  type WebHttpRequest,
  type WebHttpResponse,
} from "../src/tools/web-fetch";

const FIXED_CREATED_AT = "2026-06-26T08:00:00.000Z";

function stubFetcher(
  response: Partial<WebHttpResponse>,
  onRequest?: (request: WebHttpRequest) => void,
): WebFetcher {
  return async (request) => {
    onRequest?.(request);
    return { status: 200, text: "", headers: {}, ...response };
  };
}

function memoryArtifactStore(): { store: ToolArtifactStoreLike; writes: ToolArtifactWriteInput[] } {
  const writes: ToolArtifactWriteInput[] = [];
  return {
    writes,
    store: {
      async writeArtifact(input) {
        writes.push(input);
        return {
          id: `artifact-${writes.length}`,
          label: input.label,
          sourceToolName: input.sourceToolName,
          contentType: input.contentType ?? "text/plain",
          createdAt: FIXED_CREATED_AT,
          charLength: input.text.length,
        };
      },
      async readArtifact(id) {
        const index = Number(id.replace(/^artifact-/, "")) - 1;
        const write = writes[index];
        if (!write) throw new Error("not found");
        const metadata: ToolArtifactMetadata = {
          id,
          label: write.label,
          sourceToolName: write.sourceToolName,
          contentType: write.contentType ?? "text/plain",
          createdAt: FIXED_CREATED_AT,
          charLength: write.text.length,
          dedupKey: write.dedupKey,
          sourceUrl: write.sourceUrl,
          sourceKind: write.sourceKind,
          sourceTextHash: write.sourceTextHash,
        };
        return { metadata, text: write.text };
      },
    },
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
    expect(details.extractor).toBe("regex-fallback");
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
    expect(text).toContain("offset 600");
    expect(details.nextOffset).toBe(600);
    expect(details.hasMore).toBe(true);
    expect(details.totalChars).toBe(5_000);
  });

  it("reads a later extracted-text window when offset is supplied", async () => {
    const body = `${"a".repeat(600)}${"b".repeat(600)}${"c".repeat(600)}`;
    const tool = createWebFetchTool({
      fetcher: stubFetcher({ text: body, headers: { "content-type": "text/plain" } }),
      charLimit: 600,
    });
    const { text, details } = await run(tool, { url: "https://example.com/big", offset: 600 });
    expect(text).toContain("characters 600-1200 of 1800");
    expect(text).not.toContain("aaaa");
    expect(text).toContain("bbbb");
    expect(details.offset).toBe(600);
    expect(details.nextOffset).toBe(1200);
    expect(details.truncated).toBe(true);
  });

  it("reports no next offset on the final extracted-text window", async () => {
    const body = `${"a".repeat(600)}${"b".repeat(200)}`;
    const tool = createWebFetchTool({
      fetcher: stubFetcher({ text: body, headers: { "content-type": "text/plain" } }),
      charLimit: 600,
    });
    const { text, details } = await run(tool, { url: "https://example.com/big", offset: 600 });
    expect(text).toContain("characters 600-800 of 800");
    expect(text).not.toContain("truncated");
    expect(details.offset).toBe(600);
    expect(details.nextOffset).toBeNull();
    expect(details.hasMore).toBe(false);
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

  it("passes the abort signal to the fetcher and stops before processing results", async () => {
    let seenSignal: AbortSignal | undefined;
    const artifacts = memoryArtifactStore();
    const fetcher: WebFetcher = (_request, signal) => {
      seenSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Aborted.")), { once: true });
      });
    };
    const tool = createWebFetchTool({ fetcher, charLimit: 10_000, artifactStore: artifacts.store });
    const controller = new AbortController();

    const pending = tool.execute("call-1", { url: "https://example.com/slow" }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(/Aborted/);
    expect(seenSignal).toBe(controller.signal);
    expect(artifacts.writes).toHaveLength(0);
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

  it("writes full readable source text to an artifact when an artifact store is available", async () => {
    const artifacts = memoryArtifactStore();
    const sourceSentence = "Grounded source text that should remain inspectable and citable.";
    const sourceBody = `${sourceSentence} `.repeat(12).trim();
    const tool = createWebFetchTool({
      fetcher: stubFetcher({
        text: `<html>
          <head><title>Research Doc</title></head>
          <body>
            <nav>Product nav</nav>
            <main><p>${sourceBody}</p></main>
          </body>
        </html>`,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      charLimit: 30,
      artifactStore: artifacts.store,
    });

    const { text, details } = await run(tool, { url: "https://example.com/research" });

    expect(text).toContain("Source artifact: [Research Doc](artifact:artifact-1)");
    expect(text).toContain("truncated at 500 characters");
    expect(details).toMatchObject({
      sourceArtifactId: "artifact-1",
      sourceArtifactCitation: "[Research Doc](artifact:artifact-1)",
      sourceArtifactDuplicate: false,
      extractor: "readability-lite",
    });
    expect(artifacts.writes).toHaveLength(1);
    expect(artifacts.writes[0].label).toBe("Source: Research Doc");
    expect(artifacts.writes[0].text).toContain(sourceSentence);
    expect(artifacts.writes[0].text).not.toContain("Product nav");
    expect(parseSourceReference(String(details.sourceArtifactCitation))).toEqual({
      type: "artifact",
      artifactId: "artifact-1",
      label: "Research Doc",
    });
  });

  it("normalizes transcript responses into transcript source artifacts", async () => {
    const artifacts = memoryArtifactStore();
    const tool = createWebFetchTool({
      fetcher: stubFetcher({
        text: [
          "WEBVTT",
          "",
          "00:00:00.000 --> 00:00:02.000",
          "<v Speaker>Vault agents should cite imported transcripts.</v>",
          "",
          "00:00:02.000 --> 00:00:04.000",
          "Video summaries need inspectable provenance.",
        ].join("\n"),
        headers: { "content-type": "text/vtt; charset=utf-8" },
      }),
      charLimit: 10_000,
      artifactStore: artifacts.store,
    });

    const { text, details } = await run(tool, { url: "https://example.com/talk.vtt" });

    expect(text).toContain("Vault agents should cite imported transcripts.");
    expect(text).toContain("Video summaries need inspectable provenance.");
    expect(text).not.toContain("-->");
    expect(details).toMatchObject({
      sourceKind: "transcript",
      transcriptFormat: "vtt",
      sourceArtifactId: "artifact-1",
    });
    expect(artifacts.writes[0]).toMatchObject({
      sourceKind: "transcript",
    });
    expect(artifacts.writes[0].text).toContain("source_kind: transcript");
    expect(artifacts.writes[0].text).toContain('transcript_format: "vtt"');
    expect(artifacts.writes[0].text).not.toContain("-->");
  });

  it("follows redirects and re-validates each hop against the SSRF gate", async () => {
    const requested: string[] = [];
    const fetcher: WebFetcher = async (request): Promise<WebHttpResponse> => {
      requested.push(request.url);
      if (request.url === "https://example.com/start") {
        return { status: 302, text: "", headers: { location: "https://example.com/final" } };
      }
      return { status: 200, text: "<p>Arrived.</p>", headers: { "content-type": "text/html" } };
    };
    const tool = createWebFetchTool({ fetcher, charLimit: 10_000 });
    const { text } = await run(tool, { url: "https://example.com/start" });
    expect(requested).toEqual(["https://example.com/start", "https://example.com/final"]);
    expect(text).toContain("Arrived.");
  });

  it("refuses a redirect that points at a local or private address", async () => {
    const requested: string[] = [];
    const fetcher: WebFetcher = async (request) => {
      requested.push(request.url);
      return { status: 301, text: "", headers: { location: "http://169.254.169.254/latest/meta-data" } };
    };
    const tool = createWebFetchTool({ fetcher, charLimit: 10_000 });
    await expect(run(tool, { url: "https://example.com/redirect" })).rejects.toThrow(/local or private/i);
    expect(requested).toEqual(["https://example.com/redirect"]);
  });

  it("stops after too many redirects", async () => {
    const fetcher: WebFetcher = async (request) => ({
      status: 302,
      text: "",
      headers: { location: `${request.url}/next` },
    });
    const tool = createWebFetchTool({ fetcher, charLimit: 10_000 });
    await expect(run(tool, { url: "https://example.com/loop" })).rejects.toThrow(/too many redirects/i);
  });

  it("deduplicates repeated fetch source artifacts for the same canonical source", async () => {
    const artifacts = memoryArtifactStore();
    const tool = createWebFetchTool({
      fetcher: stubFetcher({
        text: "<html><head><title>Doc</title></head><body><main><p>Same source body.</p></main></body></html>",
        headers: { "content-type": "text/html" },
      }),
      charLimit: 10_000,
      artifactStore: artifacts.store,
    });

    const first = await run(tool, { url: "https://example.com/doc?b=2&a=1#ignored" });
    const second = await run(tool, { url: "https://example.com/doc?a=1&b=2" });

    expect(artifacts.writes).toHaveLength(1);
    expect(first.details.sourceArtifactId).toBe("artifact-1");
    expect(second.details.sourceArtifactId).toBe("artifact-1");
    expect(first.details.sourceArtifactDuplicate).toBe(false);
    expect(second.details.sourceArtifactDuplicate).toBe(true);
    expect(second.text).toContain("Source artifact: [Doc](artifact:artifact-1) (already imported)");
  });
});
