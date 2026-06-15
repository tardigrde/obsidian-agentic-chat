import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { truncateToolOutput } from "../vault/truncate";
import { throwIfAborted, type WebFetcher, type WebHttpRequest } from "./web-fetch";

/** Supported search backends. Tavily/Brave need an API key; SearXNG needs a URL. */
export type WebSearchProvider = "tavily" | "brave" | "searxng";

export const WEB_SEARCH_PROVIDERS: WebSearchProvider[] = ["tavily", "brave", "searxng"];

export const WEB_SEARCH_PROVIDER_LABELS: Record<WebSearchProvider, string> = {
  tavily: "Tavily (LLM-native, API key)",
  brave: "Brave Search (API key)",
  searxng: "SearXNG (self-hosted, no key)",
};

export interface WebSearchConfig {
  provider: WebSearchProvider;
  /** API key for Tavily/Brave. Unused by SearXNG. */
  apiKey: string;
  /** Base URL of a self-hosted SearXNG instance. Used only by SearXNG. */
  searxngUrl: string;
  /** Default number of results to return. */
  maxResults: number;
  fetcher: WebFetcher;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Hard ceiling so a single call can't pull an unbounded result set. */
const MAX_RESULTS = 10;

interface ProviderAdapter {
  /** Return an error message when the config can't drive this provider, else undefined. */
  validate: (config: WebSearchConfig) => string | undefined;
  buildRequest: (query: string, maxResults: number, config: WebSearchConfig) => WebHttpRequest;
  parse: (body: unknown) => WebSearchResult[];
}

const TAVILY: ProviderAdapter = {
  validate: (config) => (config.apiKey.trim() ? undefined : "web_search: set a Tavily API key in plugin settings."),
  buildRequest: (query, maxResults, config) => ({
    url: "https://api.tavily.com/search",
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic" }),
  }),
  parse: (body) => {
    const results = asArray(asRecord(body).results);
    return results.map((item) => {
      const record = asRecord(item);
      return {
        title: asString(record.title),
        url: asString(record.url),
        snippet: asString(record.content),
      };
    });
  },
};

const BRAVE: ProviderAdapter = {
  validate: (config) =>
    config.apiKey.trim() ? undefined : "web_search: set a Brave Search API key in plugin settings.",
  buildRequest: (query, maxResults, config) => {
    const params = new URLSearchParams({ q: query, count: String(maxResults) });
    return {
      url: `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
      method: "GET",
      headers: { Accept: "application/json", "X-Subscription-Token": config.apiKey.trim() },
    };
  },
  parse: (body) => {
    const results = asArray(asRecord(asRecord(body).web).results);
    return results.map((item) => {
      const record = asRecord(item);
      return {
        title: asString(record.title),
        url: asString(record.url),
        snippet: asString(record.description),
      };
    });
  },
};

const SEARXNG: ProviderAdapter = {
  validate: (config) =>
    config.searxngUrl.trim() ? undefined : "web_search: set a SearXNG instance URL in plugin settings.",
  buildRequest: (query, maxResults, config) => {
    const base = config.searxngUrl.trim().replace(/\/+$/, "");
    const params = new URLSearchParams({ q: query, format: "json", count: String(maxResults) });
    return { url: `${base}/search?${params.toString()}`, method: "GET", headers: { Accept: "application/json" } };
  },
  parse: (body) => {
    const results = asArray(asRecord(body).results);
    return results.map((item) => {
      const record = asRecord(item);
      return {
        title: asString(record.title),
        url: asString(record.url),
        snippet: asString(record.content),
      };
    });
  },
};

const ADAPTERS: Record<WebSearchProvider, ProviderAdapter> = {
  tavily: TAVILY,
  brave: BRAVE,
  searxng: SEARXNG,
};

const SearchParameters = Type.Object({
  query: Type.String({ description: "The search query" }),
  maxResults: Type.Optional(Type.Number({ description: `Number of results to return (1-${MAX_RESULTS})` })),
});

/**
 * The `web_search` tool: query a configured search backend and return ranked
 * results (title, URL, snippet). Read-only, but it sends the query off-device,
 * so it is only registered when web access is enabled.
 */
export function createWebSearchTool(config: WebSearchConfig): AgentTool<typeof SearchParameters> {
  return {
    name: "web_search",
    label: "Web search",
    description:
      "Search the web and return ranked results (title, URL, snippet). " +
      "Follow up with fetch_url to read a result in full. " +
      "Sends the query off-device. Keep the result URLs so you can cite them.",
    parameters: SearchParameters,
    execute: async (_id, params, signal) => {
      const adapter = ADAPTERS[config.provider];
      const invalid = adapter.validate(config);
      if (invalid) throw new Error(invalid);
      const query = params.query.trim();
      if (!query) throw new Error("web_search: provide a non-empty query.");
      const maxResults = clampResults(params.maxResults ?? config.maxResults);
      throwIfAborted(signal);
      const response = await config.fetcher(adapter.buildRequest(query, maxResults, config), signal);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`web_search failed via ${config.provider} (HTTP ${response.status}).`);
      }
      const results = adapter.parse(safeJsonParse(response.text)).filter((result) => result.url).slice(0, maxResults);
      return {
        content: [{ type: "text", text: truncateToolOutput(formatResults(query, results)) }],
        details: { provider: config.provider, query, count: results.length, results },
      };
    },
  };
}

function formatResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) return `No web results for "${query}".`;
  const lines = results.map((result, index) => {
    const title = result.title || result.url;
    const snippet = result.snippet ? `\n   ${result.snippet}` : "";
    return `${index + 1}. ${title}\n   ${result.url}${snippet}`;
  });
  return [`Web results for "${query}":`, "", ...lines].join("\n");
}

function clampResults(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), MAX_RESULTS);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
