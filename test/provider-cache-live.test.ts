import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface ProviderCacheLiveModule {
  buildStablePrefix(chars: number): string;
  chatCompletionsUrl(baseUrl: string): string;
  normalizeBaseUrl(baseUrl: string): string;
  parseUsage(rawUsage: unknown): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    raw: unknown;
  };
  parseEnvFile(text: string): Record<string, string>;
  renderMarkdown(report: {
    status: string;
    model: string;
    endpoint: string;
    turns: number;
    prefixChars: number;
    minCacheRead: number;
    summary: { maxWarmCacheRead: number; warmCacheRead: number };
    results: Array<{
      turn: number;
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
    }>;
  }): string;
  reportStatus(summary: { maxWarmCacheRead: number }, minCacheRead: number): "pass" | "fail";
  summarize(
    results: Array<{
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
    }>,
  ): {
    aggregate: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
    maxWarmCacheRead: number;
    warmCacheRead: number;
  };
}

async function loadProviderCacheLive(): Promise<ProviderCacheLiveModule> {
  return import(pathToFileURL(path.join(process.cwd(), "scripts/eval-provider-cache-live.mjs")).href) as Promise<ProviderCacheLiveModule>;
}

describe("provider-cache live eval helpers", () => {
  it("normalizes OpenAI-compatible gateway roots to chat completions endpoints", async () => {
    const evalModule = await loadProviderCacheLive();

    expect(evalModule.chatCompletionsUrl("https://openwebui.example.com/")).toBe(
      "https://openwebui.example.com/api/chat/completions",
    );
    expect(evalModule.chatCompletionsUrl("https://llm.example/api")).toBe("https://llm.example/api/chat/completions");
    expect(evalModule.chatCompletionsUrl("https://llm.example/v1/chat/completions")).toBe(
      "https://llm.example/v1/chat/completions",
    );
  });

  it("parses provider cache usage variants into plugin usage fields", async () => {
    const evalModule = await loadProviderCacheLive();

    expect(
      evalModule.parseUsage({
        prompt_tokens: 1000,
        completion_tokens: 10,
        total_tokens: 1010,
        prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
      }),
    ).toMatchObject({ input: 200, output: 10, cacheRead: 700, cacheWrite: 100, totalTokens: 1010 });

    expect(
      evalModule.parseUsage({
        prompt_tokens: 1000,
        completion_tokens: 10,
        prompt_cache_hit_tokens: 512,
        prompt_cache_creation_tokens: 128,
      }),
    ).toMatchObject({ input: 360, output: 10, cacheRead: 512, cacheWrite: 128, totalTokens: 1010 });
  });

  it("parses local env files without requiring shell sourcing", async () => {
    const evalModule = await loadProviderCacheLive();

    expect(
      evalModule.parseEnvFile(`
        # comment
        export OPENWEBUI_BASE_URL="https://llm.example/api"
        OPENWEBUI_MODEL='model/id'
        OPENWEBUI_API_KEY=secret # local comment
      `),
    ).toEqual({
      OPENWEBUI_BASE_URL: "https://llm.example/api",
      OPENWEBUI_MODEL: "model/id",
      OPENWEBUI_API_KEY: "secret",
    });
  });

  it("evaluates only warm turns for the provider-cache pass condition", async () => {
    const evalModule = await loadProviderCacheLive();
    const summary = evalModule.summarize([
      { usage: { input: 1000, output: 1, cacheRead: 900, cacheWrite: 0, totalTokens: 1901 } },
      { usage: { input: 1000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1001 } },
      { usage: { input: 100, output: 1, cacheRead: 850, cacheWrite: 0, totalTokens: 951 } },
    ]);

    expect(summary.aggregate).toEqual({ input: 2100, output: 3, cacheRead: 1750, cacheWrite: 0, totalTokens: 3853 });
    expect(summary.maxWarmCacheRead).toBe(850);
    expect(summary.warmCacheRead).toBe(850);
    expect(evalModule.reportStatus(summary, 1)).toBe("pass");
    expect(evalModule.reportStatus(summary, 851)).toBe("fail");
  });

  it("renders a compact markdown report with per-turn cache fields", async () => {
    const evalModule = await loadProviderCacheLive();
    const markdown = evalModule.renderMarkdown({
      status: "pass",
      model: "model/id",
      endpoint: "https://llm.example/api/chat/completions",
      turns: 2,
      prefixChars: 16000,
      minCacheRead: 1,
      summary: { maxWarmCacheRead: 512, warmCacheRead: 512 },
      results: [
        { turn: 1, usage: { input: 1000, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 1002 } },
        { turn: 2, usage: { input: 488, output: 2, cacheRead: 512, cacheWrite: 0, totalTokens: 1002 } },
      ],
    });

    expect(markdown).toContain("# Provider Cache Live Eval");
    expect(markdown).toContain("- status: pass");
    expect(markdown).toContain("| Turn | Input | Cache read | Cache write | Output | Total |");
    expect(markdown).toContain("| 2 | 488 | 512 | 0 | 2 | 1002 |");
  });

  it("builds a deterministic stable prefix at the requested size", async () => {
    const evalModule = await loadProviderCacheLive();
    const first = evalModule.buildStablePrefix(1024);
    const second = evalModule.buildStablePrefix(1024);

    expect(first).toBe(second);
    expect(first).toHaveLength(1024);
    expect(first).toContain("provider-cache eval stable prefix");
  });
});
