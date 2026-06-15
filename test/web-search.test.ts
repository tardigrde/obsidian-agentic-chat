import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WebFetcher, WebHttpRequest, WebHttpResponse } from "../src/tools/web-fetch";
import { createWebSearchTool, type WebSearchConfig } from "../src/tools/web-search";

function stubFetcher(
  response: Partial<WebHttpResponse>,
  onRequest?: (request: WebHttpRequest) => void,
): WebFetcher {
  return async (request) => {
    onRequest?.(request);
    return { status: 200, text: "", headers: {}, ...response };
  };
}

function baseConfig(overrides: Partial<WebSearchConfig> = {}): WebSearchConfig {
  return {
    provider: "tavily",
    apiKey: "tvly-key",
    searxngUrl: "",
    maxResults: 5,
    fetcher: stubFetcher({ text: "{}" }),
    ...overrides,
  };
}

async function run(tool: AgentTool, params: unknown): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await tool.execute("call-1", params as never);
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return { text, details: (result.details ?? {}) as Record<string, unknown> };
}

describe("web_search tool", () => {
  it("queries Tavily and parses results", async () => {
    let seen: WebHttpRequest | undefined;
    const fetcher = stubFetcher(
      {
        text: JSON.stringify({
          results: [
            { title: "First", url: "https://a.example/1", content: "snippet one" },
            { title: "Second", url: "https://b.example/2", content: "snippet two" },
          ],
        }),
      },
      (req) => {
        seen = req;
      },
    );
    const tool = createWebSearchTool(baseConfig({ fetcher }));
    const { text, details } = await run(tool, { query: "obsidian plugins" });

    expect(seen?.url).toBe("https://api.tavily.com/search");
    expect(seen?.method).toBe("POST");
    expect(seen?.headers?.Authorization).toBe("Bearer tvly-key");
    expect(JSON.parse(seen?.body ?? "{}")).toMatchObject({ query: "obsidian plugins", max_results: 5 });
    expect(details.count).toBe(2);
    expect(text).toContain("1. First");
    expect(text).toContain("https://a.example/1");
    expect(text).toContain("snippet one");
  });

  it("builds a Brave GET request and parses web.results", async () => {
    let seen: WebHttpRequest | undefined;
    const fetcher = stubFetcher(
      {
        text: JSON.stringify({ web: { results: [{ title: "B", url: "https://brave.example", description: "desc" }] } }),
      },
      (req) => {
        seen = req;
      },
    );
    const tool = createWebSearchTool(baseConfig({ provider: "brave", apiKey: "brave-key", fetcher }));
    const { details } = await run(tool, { query: "cats" });

    expect(seen?.url).toContain("https://api.search.brave.com/res/v1/web/search?");
    expect(seen?.url).toContain("q=cats");
    expect(seen?.headers?.["X-Subscription-Token"]).toBe("brave-key");
    expect(details.count).toBe(1);
  });

  it("builds a SearXNG GET request against the configured instance", async () => {
    let seen: WebHttpRequest | undefined;
    const fetcher = stubFetcher(
      { text: JSON.stringify({ results: [{ title: "S", url: "https://s.example", content: "c" }] }) },
      (req) => {
        seen = req;
      },
    );
    const tool = createWebSearchTool(
      baseConfig({ provider: "searxng", apiKey: "", searxngUrl: "https://searx.example/", fetcher }),
    );
    const { details } = await run(tool, { query: "dogs" });

    expect(seen?.url).toContain("https://searx.example/search?");
    expect(seen?.url).toContain("format=json");
    expect(details.count).toBe(1);
  });

  it("errors clearly when the provider is unconfigured", async () => {
    const tavily = createWebSearchTool(baseConfig({ apiKey: "" }));
    await expect(run(tavily, { query: "x" })).rejects.toThrow(/Tavily API key/i);

    const searxng = createWebSearchTool(baseConfig({ provider: "searxng", apiKey: "", searxngUrl: "" }));
    await expect(run(searxng, { query: "x" })).rejects.toThrow(/SearXNG/i);
  });

  it("clamps the requested result count and forwards it", async () => {
    let seen: WebHttpRequest | undefined;
    const fetcher = stubFetcher({ text: "{}" }, (req) => {
      seen = req;
    });
    const tool = createWebSearchTool(baseConfig({ fetcher }));
    await run(tool, { query: "x", maxResults: 999 });
    expect(JSON.parse(seen?.body ?? "{}").max_results).toBe(10);
  });

  it("reports an empty result set without throwing", async () => {
    const tool = createWebSearchTool(baseConfig({ fetcher: stubFetcher({ text: JSON.stringify({ results: [] }) }) }));
    const { text, details } = await run(tool, { query: "nothing here" });
    expect(details.count).toBe(0);
    expect(text).toContain("No web results");
  });

  it("errors on a non-2xx response", async () => {
    const tool = createWebSearchTool(baseConfig({ fetcher: stubFetcher({ status: 500, text: "boom" }) }));
    await expect(run(tool, { query: "x" })).rejects.toThrow(/HTTP 500/);
  });
});
