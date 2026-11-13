import type { WebFetcher } from "../tools/web-fetch";
import { authenticateMcpServer, type McpOAuthCallbackReceiver, type McpOAuthProgressEvent } from "./oauth";
import { mcpServerEndpointProblem, type McpServerSettings } from "./settings";
import { probeMcpServer, type McpServerProbeResult } from "./tools";

/**
 * What the non-UI MCP admin flow needs from its caller. The settings section
 * supplies the real save, state mirror, and transport; tests supply fakes.
 */
export interface McpServerAdminDeps {
  /** Persist the settings that hold the server. */
  save(): Promise<void>;
  /** Mirror client-owned fields into plugin state where applicable. */
  sync(server: McpServerSettings): void;
  /** Transport for the MCP handshake. */
  fetcher: WebFetcher;
  /** Mobile OAuth callback receiver; undefined uses the loopback receiver. */
  callbackReceiver?: McpOAuthCallbackReceiver;
  /** Progress sink for the OAuth sign-in flow. */
  onProgress?: (event: McpOAuthProgressEvent) => void;
}

/**
 * Probe a server, cache its tools, enable it, and persist the result. Throws
 * before any request when the endpoint is unusable.
 */
export async function probeAndCache(
  server: McpServerSettings,
  deps: McpServerAdminDeps,
): Promise<McpServerProbeResult> {
  const endpointProblem = mcpServerEndpointProblem(server.url);
  if (endpointProblem) throw new Error(endpointProblem);
  return probeAndPersist(server, deps, true);
}

/**
 * Run OAuth sign-in, then probe and cache tools. Authentication does not change
 * the server's enabled flag; the user's toggle stays authoritative.
 */
export async function authenticateAndProbe(
  server: McpServerSettings,
  deps: McpServerAdminDeps,
): Promise<McpServerProbeResult> {
  await authenticateMcpServer(server, deps.fetcher, {
    callbackReceiver: deps.callbackReceiver,
    onProgress: deps.onProgress,
  });
  deps.sync(server);
  return probeAndPersist(server, deps, false);
}

async function probeAndPersist(
  server: McpServerSettings,
  deps: McpServerAdminDeps,
  markEnabled: boolean,
): Promise<McpServerProbeResult> {
  const result = await probeMcpServer(server, deps.fetcher, {
    onServerChanged: async (changed) => {
      deps.sync(changed);
      await deps.save();
    },
  });
  server.knownTools = result.tools;
  if (markEnabled) server.enabled = true;
  deps.sync(server);
  await deps.save();
  return result;
}
