import type { App } from "obsidian";
import { clearMcpPerToolApprovals, setPerToolApproval } from "./agent/approval";
import {
  createMcpServerState,
  mcpServerStateFromServer,
  nextUniqueMcpServerId,
  resetMcpCredentials,
  resetMcpServerSecretRefs,
  serverIdFromMcpUrl,
  type McpServerSettings,
  type McpServerState,
} from "./mcp/settings";
import { localMcpToolNames } from "./mcp/tools";
import { mcpCredentialResourceChanged, mcpEndpointProblem, mcpKnownToolLocalName, mcpSecretIds } from "./settings-mcp-state";
import type { AgenticChatSettings } from "./settings-schema";
import { ObsidianSecretStore } from "./secrets/secret-store";
import { errorMessage } from "./utils/errors";

/**
 * MCP server edits the settings tab applies: id renames, endpoint changes, and
 * the plugin-state mirror. No UI; `app` is only used to clear secret slots.
 */

export function ensureMcpStateEntry(settings: AgenticChatSettings, id: string): McpServerState {
  const existing = settings.plugins.mcpState[id];
  if (existing) return existing;
  const created = createMcpServerState(id);
  settings.plugins.mcpState[id] = created;
  return created;
}

export function syncMcpServerToState(settings: AgenticChatSettings, server: McpServerSettings): void {
  if (server.source !== "plugin") return;
  const state = ensureMcpStateEntry(settings, server.id);
  const next = mcpServerStateFromServer(server);
  // Preserve secret ids already in state (they are derived from id, but keep if present)
  state.enabled = next.enabled;
  state.approval = next.approval;
  state.authType = next.authType;
  state.authHeaderName = next.authHeaderName;
  state.authHeaderValueSecretId = next.authHeaderValueSecretId;
  state.authHeaderValue = next.authHeaderValue;
  state.oauth = next.oauth;
  state.knownTools = next.knownTools;
  state.enabledTools = [...next.enabledTools];
  state.disabledTools = [...next.disabledTools];
  state.pendingOAuthChallenge = next.pendingOAuthChallenge;
  state.pendingOAuthResourceUrl = next.pendingOAuthResourceUrl;
  if (next.lastUrl) state.lastUrl = next.lastUrl;
  else delete state.lastUrl;
}

export function nextMcpServerId(
  settings: AgenticChatSettings,
  base: string,
  current?: McpServerSettings,
): string {
  const used = new Set([
    ...settings.mcp.servers.filter((entry) => entry !== current).map((entry) => entry.id),
    ...Object.keys(settings.plugins.mcpState).filter((id) => id !== current?.id),
  ]);
  return nextUniqueMcpServerId(base, used);
}

export function updateMcpServerEndpoint(
  app: App | undefined,
  settings: AgenticChatSettings,
  server: McpServerSettings,
  value: string,
): { clearedCredentials: boolean; shouldDisplay: boolean } {
  const previousUrl = server.url;
  const previousId = server.id;
  const previousEndpointProblem = mcpEndpointProblem(previousUrl);
  const wasEnabled = server.enabled;
  server.url = value.trim();
  const suggestedId = serverIdFromMcpUrl(server.url);
  if (suggestedId && previousId === "mcp" && (!previousUrl || previousUrl === "https://")) {
    renameMcpServer(app, settings, server, nextMcpServerId(settings, suggestedId, server));
  }
  let clearedCredentials = false;
  if (previousUrl.trim() !== server.url.trim()) {
    clearMcpKnownToolsAndApprovals(settings, server);
    if (mcpCredentialResourceChanged(previousUrl, server.url)) {
      resetMcpCredentials(server);
      clearedCredentials = true;
    }
  }
  if (!mcpEndpointProblem(server.url)) server.enabled = true;
  syncMcpServerToState(settings, server);
  return {
    clearedCredentials,
    shouldDisplay:
      Boolean(previousEndpointProblem) !== Boolean(mcpEndpointProblem(server.url)) ||
      wasEnabled !== server.enabled ||
      previousId !== server.id,
  };
}

export function renameMcpServer(app: App | undefined, settings: AgenticChatSettings, server: McpServerSettings, nextId: string): void {
  const previousId = server.id;
  if (previousId === nextId) return;
  const previousSecretIds = mcpSecretIds(server);
  const previousApprovals = clearMcpPerToolApprovals(settings.approval, previousId);
  const previousLocalNames = server.knownTools.map((tool) => mcpKnownToolLocalName(server, tool));
  const previousState = settings.plugins.mcpState[previousId];
  server.id = nextId;
  resetMcpServerSecretRefs(server);
  if (previousState && server.source === "plugin") {
    settings.plugins.mcpState[nextId] = previousState;
    // Re-key secret ids inside the moved state
    previousState.authHeaderValueSecretId = server.authHeaderValueSecretId;
    previousState.oauth.clientSecretSecretId = server.oauth.clientSecretSecretId;
    previousState.oauth.accessTokenSecretId = server.oauth.accessTokenSecretId;
    previousState.oauth.refreshTokenSecretId = server.oauth.refreshTokenSecretId;
    delete settings.plugins.mcpState[previousId];
  }
  clearSecretIds(app, previousSecretIds.filter((id) => !mcpSecretIds(server).includes(id)));
  rebaseMcpKnownToolLocalNames(server);
  for (let index = 0; index < server.knownTools.length; index += 1) {
    const policy = previousApprovals[previousLocalNames[index]];
    const nextLocalName = mcpKnownToolLocalName(server, server.knownTools[index]);
    if (policy) setPerToolApproval(settings.approval, nextLocalName, policy);
  }
  syncMcpServerToState(settings, server);
}

export function clearMcpKnownToolsAndApprovals(settings: AgenticChatSettings, server: McpServerSettings): void {
  clearMcpPerToolApprovals(settings.approval, server.id);
  server.knownTools = [];
  syncMcpServerToState(settings, server);
}

export function clearMcpSecretSlots(app: App | undefined, server: McpServerSettings): void {
  clearSecretIds(app, mcpSecretIds(server));
}

function rebaseMcpKnownToolLocalNames(server: McpServerSettings): void {
  const localNames = localMcpToolNames(server.id, server.knownTools.map((tool) => tool.name));
  for (let index = 0; index < server.knownTools.length; index += 1) {
    server.knownTools[index].localName = localNames[index];
  }
}

function clearSecretIds(app: App | undefined, secretIds: string[]): void {
  const secretStorage = (app as { secretStorage?: { setSecret?: (id: string, value: string) => void } } | undefined)
    ?.secretStorage;
  if (!app || !secretStorage?.setSecret) return;
  const store = new ObsidianSecretStore(app);
  for (const id of secretIds) {
    try {
      store.deleteSecret(id);
    } catch (error) {
      console.warn(`Agentic Chat: failed to clear secret ${id}: ${errorMessage(error)}`);
    }
  }
}
