import { type App, TFolder } from "obsidian";
import { type AgenticChatSettings } from "../settings";
import { createMcpServerSettings, normalizeMcpServerId, type McpServerSettings } from "../mcp/settings";
import {
  DEFAULT_PLUGINS_FOLDER,
  loadPlugins,
  pluginMcpServerId,
  type LoadedPlugin,
} from "./loader";
import { AGENT_PLUGINS_MCP_SCHEMA_ID, AGENT_PLUGINS_SCHEMA_ID, slugifyPluginName } from "./manifest";

export interface GenerateMcpPackageResult {
  /** Vault path of the generated package directory. */
  rootPath: string;
  /** Manifest name of the generated plugin. */
  pluginName: string;
  /** Server key inside the generated mcp.json. */
  serverKey: string;
}

export interface LegacyMigrationResult {
  /** Number of legacy MCP servers converted into the "legacy-mcp" package. */
  migrated: number;
}

/**
 * Cache + write helpers for Agent Plugins. Loads plugins fresh when asked or
 * from cache; generates single-server packages from the MCP settings UI; runs
 * the one-shot legacy-server migration.
 */
export class PluginService {
  private cache: LoadedPlugin[] | null = null;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => AgenticChatSettings,
    private readonly saveSettings?: () => void | Promise<void>,
  ) {}

  /** Load (or reuse the cache of) the plugin packages. */
  async load(): Promise<LoadedPlugin[]> {
    if (this.cache) return this.cache;
    return this.reload();
  }

  /** Recompute the plugin packages from the vault, dropping the cache. */
  async reload(): Promise<LoadedPlugin[]> {
    const settings = this.getSettings();
    this.cache = await loadPlugins(this.app, {
      folder: settings.plugins.folder,
      enabledPlugins: settings.plugins.enabled,
    });
    return this.cache;
  }

  getLoaded(): LoadedPlugin[] {
    return this.cache ?? [];
  }

  invalidate(): void {
    this.cache = null;
  }

  /**
   * Write a real Agent Plugins package for a single remote MCP server, so
   * users never have to hand-author files. MCP-only plugins are valid (§6.2).
   */
  async generateMcpServerPackage(input: {
    serverName: string;
    url: string;
  }): Promise<GenerateMcpPackageResult> {
    const pluginName = await this.nextAvailablePluginName(input.serverName);
    const rootPath = `${this.pluginsFolder()}/${pluginName}`;
    const serverKey = normalizeMcpServerId(input.serverName) || "mcp";
    await this.ensureFolder(rootPath);
    await this.app.vault.create(
      `${rootPath}/plugin.json`,
      `${JSON.stringify(
        {
          $schema: AGENT_PLUGINS_SCHEMA_ID,
          name: pluginName,
          version: "1.0.0",
          description: `MCP server "${input.serverName}" added from the Agentic Chat settings.`,
        },
        null,
        2,
      )}\n`,
    );
    await this.app.vault.create(
      `${rootPath}/mcp.json`,
      `${JSON.stringify(
        {
          $schema: AGENT_PLUGINS_MCP_SCHEMA_ID,
          mcpServers: {
            [serverKey]: { type: "streamable-http", url: input.url },
          },
        },
        null,
        2,
      )}\n`,
    );
    this.invalidate();
    return { rootPath, pluginName, serverKey };
  }

  /**
   * One-shot migration: convert persisted legacy MCP servers into a
   * "legacy-mcp" package and remap client-owned state (enabled, approval,
   * knownTools, auth records) to the derived server ids.
   */
  async migrateLegacyMcpServers(settings: AgenticChatSettings): Promise<LegacyMigrationResult> {
    const legacy = settings.mcp.servers;
    if (settings.plugins.migratedLegacy || legacy.length === 0) return { migrated: 0 };

    const pluginName = await this.nextAvailablePluginName("legacy-mcp");
    const rootPath = `${this.pluginsFolder()}/${pluginName}`;
    await this.ensureFolder(rootPath);
    await this.app.vault.create(
      `${rootPath}/plugin.json`,
      `${JSON.stringify(
        {
          $schema: AGENT_PLUGINS_SCHEMA_ID,
          name: pluginName,
          version: "1.0.0",
          description: "MCP servers migrated from an earlier version of Agentic Chat.",
        },
        null,
        2,
      )}\n`,
    );

    const usedKeys = new Set<string>();
    const servers = legacy
      .map((server) => {
        const key = nextUniqueKey(normalizeMcpServerId(server.name || server.id) || "mcp", usedKeys);
        return { server, key };
      })
      .filter(({ server }) => {
        try {
          const parsed = new URL(server.url);
          return parsed.protocol === "https:";
        } catch {
          return false;
        }
      });

    if (servers.length > 0) {
      const mcpServers: Record<string, unknown> = {};
      for (const { server, key } of servers) {
        mcpServers[key] = { type: "streamable-http", url: server.url };
      }
      await this.app.vault.create(
        `${rootPath}/mcp.json`,
        `${JSON.stringify({ $schema: AGENT_PLUGINS_MCP_SCHEMA_ID, mcpServers }, null, 2)}\n`,
      );
    }

    // Remap persisted client-owned state to the derived ids.
    settings.mcp.servers = servers.map(({ server, key }) => remapLegacyServer(server, pluginName, key, rootPath));
    settings.plugins.migratedLegacy = true;
    await this.saveSettings?.();
    this.invalidate();
    return { migrated: servers.length };
  }

  /**
   * Human-readable audit of all packages, used by /doctor.
   * Errors/skips become one line each, seeded by non-fatal reports after the
   * summary lines.
   */
  auditText(plugins: LoadedPlugin[]): string {
    const lines: string[] = [];
    for (const plugin of plugins) {
      const components = [
        `${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}`,
        `${plugin.mcpServers.length} MCP server${plugin.mcpServers.length === 1 ? "" : "s"}`,
      ];
      const state = plugin.enabled ? "enabled" : "disabled";
      lines.push(
        `- **${plugin.name}** (${plugin.rootPath}) — ${plugin.auditStatus}, ${state}: ${components.join(", ")}` +
          (plugin.version ? `, v${plugin.version}` : ""),
      );
      if (plugin.manifestProblem) {
        lines.push(`  - Fatal: ${plugin.manifestProblem}`);
      }
      for (const report of plugin.reports) {
        lines.push(`  - ${report.message}`);
      }
    }
    return lines.join("\n");
  }

  private pluginsFolder(): string {
    return this.getSettings().plugins.folder.trim() || DEFAULT_PLUGINS_FOLDER;
  }

  /** Create every missing segment of a vault folder path. */
  private async ensureFolder(path: string): Promise<void> {
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async nextAvailablePluginName(seed: string): Promise<string> {
    const base = slugifyPluginName(seed);
    const root = this.app.vault.getAbstractFileByPath(this.pluginsFolder());
    const existing = new Set((root instanceof TFolder ? root.children : []).map((child) => child.name));
    if (!existing.has(base)) return base;
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base}-${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }
}

function remapLegacyServer(
  server: McpServerSettings,
  pluginName: string,
  key: string,
  pluginRoot: string,
): McpServerSettings {
  return {
    ...createMcpServerSettings({
      id: pluginMcpServerId(pluginName, key),
      name: `${pluginName}: ${key}`,
      url: server.url,
      enabled: server.enabled,
      approval: server.approval !== "ask" ? server.approval : "ask",
      authType: server.authType,
      authHeaderName: server.authHeaderName,
      authHeaderValueSecretId: server.authHeaderValueSecretId,
      knownTools: server.knownTools,
    }),
    oauth: server.oauth,
    knownTools: server.knownTools,
    source: "generated",
    pluginRoot,
  };
}

function nextUniqueKey(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `${base}_${Date.now()}`;
  used.add(fallback);
  return fallback;
}