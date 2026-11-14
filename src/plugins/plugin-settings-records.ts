import type { AgenticChatSettings } from "../settings-schema";
import { clearMcpPerToolApprovals } from "../agent/approval";
import { createMcpServerState } from "../mcp/settings";
import { pruneMcpState } from "../mcp/server-state";
import { pluginMcpServerId, type LoadedPlugin } from "./loader";
import type { McpServerSettings } from "../mcp/settings";

/**
 * The one writer for the plugin-owned parts of settings: `plugins.enabled`,
 * `plugins.sources`, `plugins.mcpState`, and plugin-sourced `mcp.servers`
 * entries. Each function mutates `settings` in place and reports whether it
 * changed anything; the caller decides when to save.
 */

/** Drop settings whose package is gone from `plugins` (the fresh scan). */
export function pruneOrphanPluginSettings(settings: AgenticChatSettings, plugins: LoadedPlugin[]): boolean {
  const aliveIds = new Set(plugins.flatMap((p) => p.mcpServers.map((s) => s.id)));
  // Keep mcpState for ids still owned by a legacy user server — one prune
  // rule with the settings-tab guard (prevents collision over-delete).
  const isLegacyUserId = (id: string): boolean =>
    settings.mcp.servers.some((server) => server.id === id && server.source !== "plugin");
  let mutated = pruneMcpState(settings, aliveIds, isLegacyUserId);
  const aliveNames = new Set(plugins.map((p) => p.name));
  for (const name of Object.keys(settings.plugins.enabled)) {
    if (!aliveNames.has(name)) {
      delete settings.plugins.enabled[name];
      mutated = true;
    }
  }
  for (const name of Object.keys(settings.plugins.sources)) {
    if (!aliveNames.has(name)) {
      delete settings.plugins.sources[name];
      mutated = true;
    }
  }
  // Legacy plugin servers in mcp.servers (source=plugin) that no longer have a package
  const beforeLegacy = settings.mcp.servers.length;
  settings.mcp.servers = settings.mcp.servers.filter((server) => {
    if (server.source !== "plugin" || !server.pluginRoot) return true;
    return plugins.some((p) => p.rootPath === server.pluginRoot);
  });
  if (settings.mcp.servers.length !== beforeLegacy) mutated = true;
  return mutated;
}

/** Record where a package came from ("github:owner/repo", a URL, a wizard). */
export function recordPluginSource(settings: AgenticChatSettings, name: string, label: string): void {
  settings.plugins.sources = { ...settings.plugins.sources, [name]: label };
}

/** Ensure client-owned state exists for an imported plugin's MCP servers, defaulting to disabled. */
export function recordImportedMcpState(
  settings: AgenticChatSettings,
  pluginName: string,
  entries: ReadonlyArray<{ key: string; url: string }>,
): boolean {
  let mutated = false;
  for (const entry of entries) {
    const id = pluginMcpServerId(pluginName, entry.key);
    if (!settings.plugins.mcpState[id]) {
      const authType = isComposioServer(pluginName, entry.url) ? "oauth" : "none";
      settings.plugins.mcpState[id] = createMcpServerState(id, { enabled: false, authType, lastUrl: entry.url });
      mutated = true;
    }
  }
  return mutated;
}

/**
 * Enable the server of a package the user generated from settings. The
 * generator is an explicit opt-in, unlike imported servers, which start
 * disabled.
 */
export function enableGeneratedMcpServer(settings: AgenticChatSettings, server: McpServerSettings): void {
  const existingState = settings.plugins.mcpState[server.id];
  if (existingState) {
    existingState.enabled = true;
    existingState.lastUrl = server.url;
    return;
  }
  settings.plugins.mcpState[server.id] = createMcpServerState(server.id, {
    enabled: true,
    approval: server.approval,
    lastUrl: server.url,
  });
}

/** Forget every setting a removed package owned. */
export function forgetPluginPackage(
  settings: AgenticChatSettings,
  name: string,
  rootPath: string,
  serverIds: readonly string[],
): void {
  settings.mcp.servers = settings.mcp.servers.filter((server) => server.source !== "plugin" || server.pluginRoot !== rootPath);
  for (const id of serverIds) {
    delete settings.plugins.mcpState[id];
    clearMcpPerToolApprovals(settings.approval, id);
  }
  settings.plugins.enabled = omitKey(settings.plugins.enabled, name);
  settings.plugins.sources = omitKey(settings.plugins.sources, name);
}

function isComposioServer(pluginName: string, url: string): boolean {
  if (pluginName === "composio") return true;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "composio.dev" || h.endsWith(".composio.dev") || h === "connect.composio.dev";
  } catch {
    return false;
  }
}

/** Copy a record without `key` (no in-place mutation of the settings object). */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}
