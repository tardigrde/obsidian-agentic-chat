import { afterEach, describe, expect, it } from "vitest";
import { createProxiedFetcher } from "../src/mcp/fetcher";
import { createLoopbackOAuthCallbackReceiver } from "../src/mcp/oauth";

const originalRequire = (globalThis as { require?: unknown }).require;

function installMobileLikeRequire(): void {
  (globalThis as { require?: (moduleName: string) => unknown }).require = (moduleName: string) => {
    throw new Error(`module unavailable on mobile: ${moduleName}`);
  };
}

describe("mobile compatibility fallbacks", () => {
  afterEach(() => {
    (globalThis as { require?: unknown }).require = originalRequire;
  });

  it("reports desktop-only proxy support without throwing raw Node module errors", async () => {
    installMobileLikeRequire();

    const fetcher = createProxiedFetcher(
      { proxyUrl: "http://proxy.example.com:3128", noProxy: "" },
      async () => ({ status: 599, text: "fallback should not be used for proxied HTTPS", headers: {} }),
    );

    const response = await fetcher({
      url: "https://api.example.com/v1/chat/completions",
      method: "POST",
      headers: {},
      body: "{}",
    });

    expect(response.status).toBe(0);
    expect(response.text).toMatch(/requires Obsidian desktop with Node networking/i);
  });

  it("reports desktop-only OAuth callback support without throwing raw Node module errors", async () => {
    installMobileLikeRequire();

    await expect(createLoopbackOAuthCallbackReceiver()).rejects.toThrow(
      /MCP OAuth sign-in requires Obsidian desktop/i,
    );
  });
});
