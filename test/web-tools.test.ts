import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type WebSettings } from "../src/settings";
import { createWebTools, WEB_TOOL_NAMES } from "../src/tools/web-tools";
import type { WebFetcher } from "../src/tools/web-fetch";

const noopFetcher: WebFetcher = async () => ({ status: 200, text: "", headers: {} });

function webSettings(overrides: Partial<WebSettings> = {}): WebSettings {
  return { ...DEFAULT_SETTINGS.web, ...overrides };
}

describe("createWebTools", () => {
  it("registers nothing when web access is disabled (the egress gate)", () => {
    expect(createWebTools(webSettings({ enabled: false }), noopFetcher)).toEqual([]);
  });

  it("registers web_search and fetch_url when enabled", () => {
    const tools = createWebTools(webSettings({ enabled: true }), noopFetcher);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["fetch_url", "web_search"]);
  });

  it("exposes the web tool names for membership checks", () => {
    expect([...WEB_TOOL_NAMES].sort()).toEqual(["fetch_url", "web_search"]);
  });
});
