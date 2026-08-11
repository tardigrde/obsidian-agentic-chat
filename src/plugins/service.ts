import { type App, TFile, TFolder } from "obsidian";
import { type AgenticChatSettings } from "../settings";
import { createMcpServerSettings, normalizeMcpServerId, type McpServerSettings } from "../mcp/settings";
import { splitFrontmatter, stringField } from "../skills/skills";
import {
  DEFAULT_PLUGINS_FOLDER,
  loadPlugins,
  pluginMcpServerId,
  type LoadedPlugin,
} from "./loader";
import { AGENT_PLUGINS_MCP_SCHEMA_ID, AGENT_PLUGINS_SCHEMA_ID, isLoopbackHost, slugifyPluginName } from "./manifest";

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
  /** Names of legacy servers that cannot run under an agent plugin and were left in place. */
  skipped: string[];
}

export interface SkillsMigrationResult {
  /** Number of legacy skill/template documents converted into the "agentic-skills" package. */
  migrated: number;
  /** Number of documents skipped (empty body or unreadable). */
  skipped: number;
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
   * knownTools, auth records) to the derived server ids. HTTPS and
   * loopback-HTTP servers migrate; other schemes are left in place and
   * reported. Reuses a package left behind by a crashed run instead of
   * creating a duplicate, and only marks the migration done when settings
   * are persisted after the package exists.
   */
  async migrateLegacyMcpServers(settings: AgenticChatSettings): Promise<LegacyMigrationResult> {
    const legacy = settings.mcp.servers;
    if (settings.plugins.migratedLegacy || legacy.length === 0) return { migrated: 0, skipped: [] };

    const usedKeys = new Set<string>();
    const classified = legacy.map((server) => ({
      server,
      key: nextUniqueKey(normalizeMcpServerId(server.name || server.id) || "mcp", usedKeys),
    }));
    const migratable = classified.filter(({ server }) => isMigratableLegacyUrl(server.url));
    const skipped = classified
      .filter(({ server }) => !isMigratableLegacyUrl(server.url))
      .map(({ server }) => server.name || server.id);

    // Nothing we can carry over: keep the legacy settings untouched so the
    // user can keep using them, and never mark the migration as done.
    if (migratable.length === 0) return { migrated: 0, skipped };

    const existing = await this.findExistingPluginDir("legacy-mcp");
    const pluginName = existing ?? (await this.nextAvailablePluginName("legacy-mcp"));
    const rootPath = `${this.pluginsFolder()}/${pluginName}`;
    if (!existing) {
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
    }

    const mcpPath = `${rootPath}/mcp.json`;
    if (!this.app.vault.getAbstractFileByPath(mcpPath)) {
      const mcpServers: Record<string, unknown> = {};
      for (const { server, key } of migratable) {
        mcpServers[key] = { type: "streamable-http", url: server.url };
      }
      await this.app.vault.create(
        mcpPath,
        `${JSON.stringify({ $schema: AGENT_PLUGINS_MCP_SCHEMA_ID, mcpServers }, null, 2)}\n`,
      );
    }

    // Remap persisted client-owned state to the derived ids. Files already
    // exist at this point, so a crash after the save leaves a consistent
    // package and a rerun on the next boot reuses it.
    settings.mcp.servers = migratable.map(({ server, key }) => remapLegacyServer(server, pluginName, key, rootPath));
    settings.plugins.migratedLegacy = true;
    await this.saveSettings?.();
    this.invalidate();
    return { migrated: migratable.length, skipped };
  }

  /**
   * One-shot migration: earlier versions loaded skills (and templates) from
   * vault folders configured in settings. Those documents are copied into an
   * "agentic-skills" plugin package, keeping the plugin folder the single
   * source of truth. Templates only migrate when no skill of the same name
   * exists (the old precedence), skills are copied preserving frontmatter
   * name/description. Crash-idempotent: a package left behind by a crashed
   * run is reused and already-written documents are skipped.
   */
  async migrateLegacySkillsFolder(
    settings: AgenticChatSettings,
    legacy: { skillsFolder?: string; templatesFolder?: string },
  ): Promise<SkillsMigrationResult> {
    if (settings.plugins.skillsMigrated) return { migrated: 0, skipped: 0 };

    const folders: string[] = [];
    if (legacy.skillsFolder?.trim()) folders.push(legacy.skillsFolder.trim());
    if (legacy.templatesFolder?.trim()) folders.push(legacy.templatesFolder.trim());

    if (folders.length === 0) {
      settings.plugins.skillsMigrated = true;
      await this.saveSettings?.();
      return { migrated: 0, skipped: 0 };
    }

    const documents: Array<{ name: string; description: string; content: string }> = [];
    let skipped = 0;
    const seenNames = new Set<string>();
    for (const folder of folders) {
      for (const file of this.legacySkillFiles(folder)) {
        let raw: string;
        try {
          raw = await this.app.vault.cachedRead(file);
        } catch (error) {
          console.warn(`Agentic chat: could not read skill file ${file.path}`, error);
          skipped += 1;
          continue;
        }
        const { data, body } = splitFrontmatter(raw);
        if (!body.trim()) {
          skipped += 1;
          continue;
        }
        const name = stringField(data, "name") ?? deriveSkillName(file);
        if (seenNames.has(name)) continue;
        seenNames.add(name);
        documents.push({ name, description: stringField(data, "description") ?? name, content: body });
      }
    }

    if (documents.length === 0) {
      settings.plugins.skillsMigrated = true;
      await this.saveSettings?.();
      return { migrated: 0, skipped };
    }

    const existing = await this.findExistingPluginDir("agentic-skills");
    const pluginName = existing ?? (await this.nextAvailablePluginName("agentic-skills"));
    const rootPath = `${this.pluginsFolder()}/${pluginName}`;
    if (!existing) {
      await this.ensureFolder(rootPath);
      await this.app.vault.create(
        `${rootPath}/plugin.json`,
        `${JSON.stringify(
          {
            $schema: AGENT_PLUGINS_SCHEMA_ID,
            name: pluginName,
            version: "1.0.0",
            description: "Skills migrated from the Agentic Chat skills and templates folders.",
          },
          null,
          2,
        )}\n`,
      );
    }

    const usedDirs = new Set<string>();
    for (const document of documents) {
      const dir = uniqueSkillDir(document.name, usedDirs);
      const target = `${rootPath}/skills/${dir}/SKILL.md`;
      if (!this.app.vault.getAbstractFileByPath(target)) {
        await this.ensureFolder(`${rootPath}/skills/${dir}`);
        await this.app.vault.create(target, formatSkillDocument(document));
      }
    }

    settings.plugins.skillsMigrated = true;
    await this.saveSettings?.();
    this.invalidate();
    return { migrated: documents.length, skipped };
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

  /**
   * Reuse a package directory created by an earlier migration run that died
   * before persisting settings, so a retry never produces duplicates.
   */
  private async findExistingPluginDir(seed: string): Promise<string | null> {
    const base = slugifyPluginName(seed);
    const root = this.app.vault.getAbstractFileByPath(this.pluginsFolder());
    if (!(root instanceof TFolder)) return null;
    const dir = root.children.find((child): child is TFolder => child instanceof TFolder && child.name === base);
    if (!dir) return null;
    return this.app.vault.getAbstractFileByPath(`${dir.path}/plugin.json`) ? dir.name : null;
  }

  /**
   * Files the legacy folder loader picked up: any SKILL.md under the folder
   * plus direct Markdown children (mirrors the pre-plugin loader).
   */
  private legacySkillFiles(folder: string): TFile[] {
    const normalized = folder.replace(/\/+$/, "");
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => {
        if (normalized && file.path !== normalized && !file.path.startsWith(`${normalized}/`)) return false;
        if (file.name.toLowerCase() === "skill.md") return true;
        return (file.parent?.path ?? "") === normalized;
      })
      .sort((a, b) => a.path.localeCompare(b.path));
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

/** HTTPS, or HTTP on a loopback host: the transports an agent plugin can run. */
function isMigratableLegacyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

/** Legacy skill naming: a SKILL.md is named after its folder, a note after itself. */
function deriveSkillName(file: TFile): string {
  if (file.name.toLowerCase() === "skill.md") {
    return file.parent && file.parent.path ? file.parent.name : file.basename;
  }
  return file.basename;
}

/** Safe filesystem name for a skill directory (names stay in frontmatter). */
function uniqueSkillDir(name: string, used: Set<string>): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const base = slug || "skill";
  let candidate = base;
  for (let index = 2; used.has(candidate) && index < 100; index += 1) {
    candidate = `${base}-${index}`;
  }
  used.add(candidate);
  return candidate;
}

/** Rebuild a SKILL.md document preserving the legacy frontmatter values. */
function formatSkillDocument(document: { name: string; description: string; content: string }): string {
  const nameLine = `name: ${JSON.stringify(document.name)}`;
  const descriptionLine = `description: ${JSON.stringify(document.description)}`;
  return `---\n${nameLine}\n${descriptionLine}\n---\n${document.content}`;
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