import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type WebSettings } from "../src/settings-schema";
import { createWebTools, WEB_TOOL_NAMES } from "../src/tools/web-tools";
import type { WebBinaryFetcher, WebFetcher } from "../src/tools/web-fetch";
import type { App } from "obsidian";

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

  it("adds download_file only when the caller can write into the vault (child agents get none)", () => {
    const binary: WebBinaryFetcher = async () => ({ status: 200, bytes: new ArrayBuffer(0), headers: {} });
    const withDownload = createWebTools(webSettings({ enabled: true }), noopFetcher, undefined, { app: {} as App, isIgnored: () => false, fetcher: binary });
    expect(withDownload.map((tool) => tool.name).sort()).toEqual(["download_file", "fetch_url", "web_search"]);
    expect(createWebTools(webSettings({ enabled: false }), noopFetcher, undefined, { app: {} as App, isIgnored: () => false, fetcher: binary })).toEqual([]);
  });

  it("exposes the web tool names for membership checks", () => {
    expect([...WEB_TOOL_NAMES].sort()).toEqual(["download_file", "fetch_url", "web_search"]);
  });
});
