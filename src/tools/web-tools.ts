import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import type { WebSettings } from "../settings-schema";
import type { App } from "obsidian";
import type { IgnoreMatcher } from "../vault/ignore";
import { createWebFetchTool, type WebBinaryFetcher, type WebFetcher } from "./web-fetch";
import { createWebDownloadTool } from "./web-download";
import { createWebSearchTool } from "./web-search";

/** Names of the web tools, for tool-set membership checks. */
export const WEB_TOOL_NAMES = new Set(["web_search", "fetch_url", "download_file"]);

/** What `download_file` needs to save into the vault. Omitted for child agents: they never write. */
export interface WebDownloadDeps {
  app: App;
  isIgnored: IgnoreMatcher;
  fetcher: WebBinaryFetcher;
  /** Vault folders `download_file` never writes into. */
  blockedFolders?: readonly string[];
}

/**
 * Build the web tools (search, fetch, and download when the caller can write) when web access is enabled, else nothing.
 * The enable toggle is the egress gate: these tools send data off-device, so when
 * it's off they are not registered at all and the model can't reach the network.
 */
export function createWebTools(
  settings: WebSettings,
  fetcher: WebFetcher,
  artifactStore?: ToolArtifactStoreLike,
  download?: WebDownloadDeps,
): AgentTool[] {
  if (!settings.enabled) return [];
  return [
    createWebSearchTool({
      provider: settings.searchProvider,
      apiKey: settings.searchApiKey,
      searxngUrl: settings.searxngUrl,
      maxResults: settings.maxResults,
      fetcher,
    }),
    createWebFetchTool({ fetcher, charLimit: settings.fetchCharLimit, artifactStore, allowedHosts: settings.allowedHosts, downloadHint: Boolean(download) }),
    ...(download ? [createWebDownloadTool({ ...download, allowedHosts: settings.allowedHosts })] : []),
  ];
}
