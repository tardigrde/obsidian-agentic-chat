import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import type { WebSettings } from "../settings";
import { createWebFetchTool, type WebFetcher } from "./web-fetch";
import { createWebSearchTool } from "./web-search";

/** Names of the web tools, for tool-set membership checks. */
export const WEB_TOOL_NAMES = new Set(["web_search", "fetch_url"]);

/**
 * Build the web tools (search + fetch) when web access is enabled, else nothing.
 * The enable toggle is the egress gate: these tools send data off-device, so when
 * it's off they are not registered at all and the model can't reach the network.
 */
export function createWebTools(settings: WebSettings, fetcher: WebFetcher, artifactStore?: ToolArtifactStoreLike): AgentTool[] {
  if (!settings.enabled) return [];
  return [
    createWebSearchTool({
      provider: settings.searchProvider,
      apiKey: settings.searchApiKey,
      searxngUrl: settings.searxngUrl,
      maxResults: settings.maxResults,
      fetcher,
    }),
    createWebFetchTool({ fetcher, charLimit: settings.fetchCharLimit, artifactStore }),
  ];
}
