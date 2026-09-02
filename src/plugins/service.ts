import { type App, TFolder } from "obsidian";
import { type AgenticChatSettings } from "../settings";
import { createMcpServerState, normalizeMcpServerId } from "../mcp/settings";
import { clearMcpPerToolApprovals } from "../agent/approval";
import { BUILTIN_SKILL_DOCS } from "../skills/builtin-skills";
import type { FileTree } from "./import/archive";
import { convertToAgentPlugin } from "./import/convert";
import {
  installPackage,
  scaffoldManifest,
  type InstallResult,
  type PackageWriter,
} from "./import/install";
import { collectLegacyVaultSkills } from "./import/migrate-legacy-skills";
import { sniffSource } from "./import/sniff";
import {
  createObsidianBytesFetcher,
  parseImportSource,
  resolveImportSource,
  type ImportBytesFetcher,
} from "./import/url-source";
import {
  DEFAULT_PLUGINS_FOLDER,
  loadPlugins,
  mcpServerFromPluginEntry,
  pluginMcpServerId,
  pruneOrphanMcpState,
  type LoadedPlugin,
} from "./loader";
import { AGENT_PLUGINS_MCP_SCHEMA_ID, AGENT_PLUGINS_SCHEMA_ID, slugifyPluginName, validatePluginManifest } from "./manifest";

export interface GenerateMcpPackageResult {
  /** Vault path of the generated package directory. */
  rootPath: string;
  /** Manifest name of the generated plugin. */
  pluginName: string;
  /** Server key inside the generated mcp.json. */
  serverKey: string;
}

/**
 * Cache + write helpers for Agent Plugins. Loads plugins fresh when asked or
 * from cache; generates single-server packages from the MCP settings UI.
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
    await this.sweepImportStages();
    this.cache = await loadPlugins(this.app, {
      folder: settings.plugins.folder,
      enabledPlugins: settings.plugins.enabled,
    });
    // Prune orphaned mcpState entries that no longer have a derived server
    // (e.g. plugin removed externally). This also covers the removePackage
    // cache-miss case where we could not know the derived ids at removal time.
    const aliveIds = new Set(this.cache.flatMap((p) => p.mcpServers.map((s) => s.id)));
    const beforeMcpState = Object.keys(settings.plugins.mcpState).length;
    const beforePerTool = Object.keys(settings.approval.perTool).length;
    const deletedMcpIds = Object.keys(settings.plugins.mcpState).filter((id) => !aliveIds.has(id));
    pruneOrphanMcpState(settings.plugins.mcpState, aliveIds);
    for (const id of deletedMcpIds) {
      clearMcpPerToolApprovals(settings.approval, id);
    }
    const aliveNames = new Set(this.cache.map((p) => p.name));
    let mutated = Object.keys(settings.plugins.mcpState).length !== beforeMcpState;
    if (Object.keys(settings.approval.perTool).length !== beforePerTool) mutated = true;
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
      return this.cache!.some((p) => p.rootPath === server.pluginRoot);
    });
    if (settings.mcp.servers.length !== beforeLegacy) mutated = true;
    if (mutated) await this.saveSettings?.();
    return this.cache;
  }

  getLoaded(): LoadedPlugin[] {
    return this.cache ?? [];
  }

  /** True while the cache holds a scanned plugin list (valid or empty). */
  hasCache(): boolean {
    return this.cache !== null;
  }

  invalidate(): void {
    this.cache = null;
  }

  /**
   * Drop the cache when a vault path inside the plugins folder changed.
   * Returns true when the cache was invalidated for that path.
   */
  invalidateFor(path: string): boolean {
    const folder = this.pluginsFolder().replace(/\/+$/, "");
    if (path !== folder && !path.startsWith(`${folder}/`)) return false;
    this.cache = null;
    return true;
  }

  /** Check whether any cached plugin folder no longer exists on disk (dot-folder watcher gap). */
  async hasExternallyDeletedPlugin(): Promise<boolean> {
    if (!this.cache || this.cache.length === 0) return false;
    for (const plugin of this.cache) {
      try {
        const exists = await this.app.vault.adapter.exists(plugin.rootPath);
        if (!exists) return true;
      } catch {
        // Treat probe failure as not deleted to avoid spurious reloads.
        continue;
      }
    }
    return false;
  }

  /** List cached plugins whose folders are missing on disk. */
  async listExternallyDeletedPlugins(): Promise<LoadedPlugin[]> {
    if (!this.cache || this.cache.length === 0) return [];
    const deleted: LoadedPlugin[] = [];
    for (const plugin of this.cache) {
      try {
        const exists = await this.app.vault.adapter.exists(plugin.rootPath);
        if (!exists) deleted.push(plugin);
      } catch {
        continue;
      }
    }
    return deleted;
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
    // The vault file tree may not reflect brand-new folders immediately (or
    // at all on some platforms), so don't wait for a reload to expose the
    // server: ensure a client-owned entry exists in the state map keyed by the
    // stable id the loader will derive on its next scan.
    const derived = mcpServerFromPluginEntry(pluginName, rootPath, {
      key: serverKey,
      transport: "streamable-http",
      url: input.url,
      headers: {},
      problems: [],
    });
    // The generator is an explicit opt-in: the new server starts enabled
    // (unlike imported/plugin-declared servers, which default to disabled).
    derived.enabled = true;
    const settings = this.getSettings();
    const existingState = settings.plugins.mcpState[derived.id];
    if (existingState) {
      existingState.enabled = true;
      existingState.lastUrl = derived.url;
    } else {
      settings.plugins.mcpState[derived.id] = createMcpServerState(derived.id, {
        enabled: true,
        approval: derived.approval,
        lastUrl: derived.url,
      });
    }
    await this.saveSettings?.();
    this.invalidate();
    return { rootPath, pluginName, serverKey };
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

  /**
   * Full install pipeline from a user-supplied source string: parse the URL
   * grammar, download + extract, sniff the package layout, convert to Agent
   * Plugins, then write into the plugins folder. Throws with a user-readable
   * message on every failure shape.
   */
  async installFromSource(input: string, fetcher: ImportBytesFetcher = createObsidianBytesFetcher()): Promise<InstallResult> {
    const parsed = parseImportSource(input);
    if ("error" in parsed) throw new Error(parsed.error);
    const resolved = await resolveImportSource(parsed.parsed, fetcher);
    return this.installFromTree(resolved.tree, resolved.label);
  }

  /**
   * Install a source tree already in hand (folder picker, marketplace pick,
   * or resolved URL). Sniffs the layout and installs the first package found.
   */
  async installFromTree(tree: FileTree, label: string): Promise<InstallResult> {
    const sniffed = sniffSource(tree);
    if (sniffed.kind !== "package" || sniffed.candidates.length === 0) {
      if (sniffed.kind === "nothing") throw new Error(sniffed.error);
      throw new Error("This source is a marketplace catalog, not a plugin package. Pick a specific plugin folder instead.");
    }
    const candidate = sniffed.candidates[0];
    const converted = convertToAgentPlugin(tree, candidate);
    if (!converted.name || !converted.name.trim()) {
      throw new Error("Could not determine a package name from this source.");
    }
    if (sniffed.candidates.length > 1) {
      converted.warnings.push(
        `Found ${sniffed.candidates.length} packages in this source; installed ${converted.name}.`,
      );
    }
    // Native manifests and mcp.json are installed verbatim, so validate them
    // before they are written: a bad manifest must fail the import, not land
    // in the vault and only be rejected by the loader on the next scan.
    let nativeManifest: string | undefined;
    let nativeMcpJson: string | undefined;
    if (converted.native) {
      const manifestPath = candidate.manifestPath ?? (candidate.root ? `${candidate.root}/plugin.json` : "plugin.json");
      const manifestBytes = tree.get(manifestPath);
      if (!manifestBytes) throw new Error("The native plugin package has no plugin.json to install.");
      nativeManifest = decodeUtf8(manifestBytes);
      const validation = validatePluginManifest(nativeManifest);
      if (validation.fatal) {
        throw new Error(`The plugin package's plugin.json is invalid: ${validation.fatal}`);
      }
      const mcpBytes = tree.get(`${candidate.root ? `${candidate.root}/` : ""}mcp.json`);
      if (mcpBytes) nativeMcpJson = decodeUtf8(mcpBytes);
    }
    const result = await installPackage(this.vaultWriter(), {
      converted,
      pluginsFolder: this.pluginsFolder(),
      ...(nativeManifest ? { nativeManifest } : {}),
      ...(nativeMcpJson ? { nativeMcpJson } : {}),
    });
    this.recordSource(result.name, label);
    await this.recordPluginMcp(result.name, converted);
    if (converted.mcpEntries.length === 0) await this.saveSettings?.();
    this.invalidate();
    return result;
  }

  /**
   * Scaffold a single-skill package from the New skill wizard: a spec-valid
   * plugin.json + skills/<name>/SKILL.md, installed through the same writer.
   */
  /** True when a package with this exact name is already installed. */
  async packageExists(name: string): Promise<boolean> {
    return this.vaultWriter().folderExists(`${this.pluginsFolder()}/${name}`);
  }

  async scaffoldSkill(input: { name: string; description: string; body: string }): Promise<InstallResult> {
    if (!/[a-z0-9]/i.test(input.name)) {
      throw new Error("Skill name must contain at least one letter or digit.");
    }
    const name = slugifyPluginName(input.name);
    if (!name) throw new Error("Skill name must contain at least one letter or digit.");
    const result = await installPackage(
      this.vaultWriter(),
      {
        converted: {
          name,
          description: input.description || `${name} skill.`,
          native: false,
          skills: [
            {
              name,
              files: new Map([
                [
                  "SKILL.md",
                  new TextEncoder().encode(
                    `---\nname: ${name}\ndescription: ${JSON.stringify(input.description || `${name} skill.`)}\n---\n\n${
                      input.body.trim()
                    }\n`,
                  ),
                ],
              ]),
              warnings: [],
            },
          ],
          mcpEntries: [],
          rootFiles: new Map(),
          warnings: [],
        },
        pluginsFolder: this.pluginsFolder(),
      },
    );
    this.recordSource(result.name, "New skill wizard");
    this.invalidate();
    return result;
  }

  /**
   * Remove a package and prune its plugin-sourced MCP records. The vault
   * folder is derived from `rootPath` (the loader's reported package path),
   * not the manifest name: a folder may legitimately differ from the name
   * (renamed folder, imported packages whose folder is slugified), and
   * deleting by name would remove the wrong path and orphan the package.
   * Returns true when the folder existed on disk and was removed, false when
   * it was already absent (externally deleted).
   */
  async removePackage(name: string, rootPath: string): Promise<boolean> {
    // Determine server ids to prune before the folder is gone (cache miss → read mcp.json).
    const cached = this.cache?.find((p) => p.rootPath === rootPath || p.name === name);
    let serverIds: string[] = [];
    if (cached) {
      serverIds = cached.mcpServers.map((server) => server.id);
    } else {
      try {
        const raw = await this.app.vault.adapter.read(`${rootPath}/mcp.json`);
        if (raw) {
          const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
          const mcpServers = parsed?.mcpServers;
          if (mcpServers && typeof mcpServers === "object") {
            for (const key of Object.keys(mcpServers)) {
              serverIds.push(pluginMcpServerId(name, key));
            }
          }
        }
      } catch {
        // Best-effort only; orphans are also pruned on next reload() via aliveIds.
      }
    }
    const existed = await this.vaultWriter().folderExists(rootPath);
    await this.vaultWriter().removeFolder(rootPath);
    const settings = this.getSettings();
    settings.mcp.servers = settings.mcp.servers.filter((server) => server.source !== "plugin" || server.pluginRoot !== rootPath);
    for (const id of serverIds) {
      delete settings.plugins.mcpState[id];
      clearMcpPerToolApprovals(settings.approval, id);
    }
    const enabled = { ...settings.plugins.enabled };
    delete enabled[name];
    settings.plugins.enabled = enabled;
    const sources = { ...settings.plugins.sources };
    delete sources[name];
    settings.plugins.sources = sources;
    await this.saveSettings?.();
    this.invalidate();
    return existed;
  }

  /**
   * Materialize the `builtins` package (the plugin's own skills as a real,
   * inspectable Agent Plugins package). Only when absent — never overwrites
   * user edits (D7); use {@link repairBuiltins} to force a rewrite.
   */
  async ensureBuiltinsMaterialized(): Promise<boolean> {
    const writer = this.vaultWriter();
    const target = `${this.pluginsFolder()}/builtins`;
    if (await writer.folderExists(target)) return false;
    const files: Map<string, Uint8Array> = new Map();
    for (const skill of BUILTIN_SKILL_DOCS) {
      files.set(`skills/${skill.name}/SKILL.md`, new TextEncoder().encode(skill.doc));
    }
    await writer.ensureFolder(`${target}/skills`);
    for (const [rel, bytes] of files) {
      await writer.writeFile(`${target}/${rel}`, bytes);
    }
    await writer.writeFile(
      `${target}/plugin.json`,
      scaffoldManifest(
        "builtins",
        "Built-in skills of the Agentic Chat plugin, materialized as an editable Agent Plugins package.",
      ),
    );
    await writer.writeFile(
      `${target}/README.md`,
      "This package holds the plugin's built-in skills as a real Agent Plugins package. " +
        "Edit the SKILL.md files here to customize them; the package is only (re)created when it is missing. " +
        "Use **Repair built-ins** in the Resources tab to restore the originals.\n",
    );
    this.invalidate();
    return true;
  }

  /** Recreate the `builtins` package from scratch (Repair button). */
  async repairBuiltins(): Promise<void> {
    await this.vaultWriter().removeFolder(`${this.pluginsFolder()}/builtins`);
    await this.ensureBuiltinsMaterialized();
  }

  /**
   * One-time upgrade migration: materialize legacy `skillsFolder` /
   * `templatesFolder` vault skills into a real `legacy-skills` package so no
   * configured skills silently disappear after the Agent Plugins migration.
   * Only when the package is absent (never overwrites user edits); returns
   * false when there is nothing to preserve.
   */
  async materializeLegacySkills(folders: string[]): Promise<boolean> {
    const writer = this.vaultWriter();
    const target = `${this.pluginsFolder()}/legacy-skills`;
    if (await writer.folderExists(target)) return false;
    const skills = await collectLegacyVaultSkills(this.app, folders);
    if (skills.length === 0) return false;

    const files: Map<string, Uint8Array> = new Map();
    const usedDirs = new Set<string>();
    for (const skill of skills) {
      const base = slugifyPluginName(skill.name) || "skill";
      let dir = base;
      for (let index = 2; usedDirs.has(dir); index += 1) dir = `${base}-${index}`;
      usedDirs.add(dir);
      const description = skill.description.trim() || `${dir} skill.`;
      const doc = `---\nname: ${JSON.stringify(dir)}\ndescription: ${JSON.stringify(description)}\n---\n\n${skill.body.trim()}\n`;
      files.set(`skills/${dir}/SKILL.md`, new TextEncoder().encode(doc));
    }

    await writer.ensureFolder(`${target}/skills`);
    for (const [rel, bytes] of files) {
      await writer.writeFile(`${target}/${rel}`, bytes);
    }
    await writer.writeFile(
      `${target}/plugin.json`,
      scaffoldManifest(
        "legacy-skills",
        "Skills from the vault skills/templates folders, migrated when Agent Plugins became the single source of truth.",
      ),
    );
    await writer.writeFile(
      `${target}/README.md`,
      "This package holds the skills that used to live in the settings' Skills folder / Prompt templates folder. " +
        "Edit or remove it freely; the migration only creates it once and never overwrites your edits.\n",
    );
    this.invalidate();
    return true;
  }

  /** Remove leftover `.importing-*` stage folders a crashed install may have left. */
  async sweepImportStages(): Promise<void> {
    const root = this.app.vault.getAbstractFileByPath(this.pluginsFolder());
    if (!(root instanceof TFolder)) return;
    for (const child of root.children) {
      if (child instanceof TFolder && child.name.startsWith(".importing-")) {
        await this.vaultWriter().removeFolder(child.path);
      }
    }
  }

  private recordSource(name: string, label: string): void {
    const settings = this.getSettings();
    const sources = { ...settings.plugins.sources };
    sources[name] = label;
    settings.plugins.sources = sources;
  }

  private isComposioServer(pluginName: string, url: string): boolean {
    if (pluginName === "composio") return true;
    try {
      const h = new URL(url).hostname.toLowerCase();
      return h === "composio.dev" || h.endsWith(".composio.dev") || h === "connect.composio.dev";
    } catch {
      return false;
    }
  }

  /** Ensure client-owned state exists for an imported plugin's MCP servers, defaulting to disabled (D11). */
  private async recordPluginMcp(pluginName: string, converted: { mcpEntries: Array<{ key: string; url: string; headers?: Record<string, string> }> }): Promise<void> {
    if (converted.mcpEntries.length === 0) return;
    const settings = this.getSettings();
    let mutated = false;
    for (const entry of converted.mcpEntries) {
      const id = pluginMcpServerId(pluginName, entry.key);
      if (!settings.plugins.mcpState[id]) {
        const authType = this.isComposioServer(pluginName, entry.url) ? "oauth" : "none";
        settings.plugins.mcpState[id] = createMcpServerState(id, { enabled: false, authType, lastUrl: entry.url });
        mutated = true;
      }
    }
    if (mutated) await this.saveSettings?.();
  }

  /** Vault-backed writer used by all install paths. */
  private vaultWriter(): PackageWriter {
    const app = this.app;
    return {
      ensureFolder: async (path) => this.ensureFolder(path),
      writeFile: async (path, content) => {
        const segments = path.split("/");
        await this.ensureFolder(segments.slice(0, -1).join("/"));
        if (typeof content === "string") {
          await app.vault.create(path, content);
          return;
        }
        const text = decodeUtf8(content);
        // Text survives round-tripping; only binary files need the adapter.
        if (new TextEncoder().encode(text).every((byte, index) => byte === content[index])) {
          await app.vault.create(path, text);
        } else {
          const copy = new Uint8Array(content.length);
          copy.set(content);
          await app.vault.adapter.writeBinary(path, copy.buffer);
        }
      },
      removeFolder: async (path) => {
        const inTree = app.vault.getAbstractFileByPath(path) instanceof TFolder;
        const onDisk = await app.vault.adapter.exists(path).catch(() => false);
        if (!inTree && !onDisk) return;
        try {
          await app.vault.adapter.rmdir(path, true);
        } catch (error) {
          const message = String((error as Error)?.message ?? "");
          if (!message.includes("ENOENT")) throw error;
        }
        pruneTreeFolder(app, path);
      },
      folderExists: async (path) => {
        if (app.vault.getAbstractFileByPath(path) instanceof TFolder) return true;
        return app.vault.adapter.exists(path).catch(() => false);
      },
      renameFolder: async (from, to) => {
        await app.vault.adapter.rename(from, to);
      },
    };
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
      if (this.app.vault.getAbstractFileByPath(current) instanceof TFolder) continue;
      // The vault's live tree does not index dot-folders (e.g. .agentic-plugins)
      // created outside the session; trust the adapter when the folder is on
      // disk, or vault.createFolder throws "Folder already exists.".
      if (await this.app.vault.adapter.exists(current)) continue;
      await this.app.vault.createFolder(current);
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

/** Drop a folder from the vault file tree after an adapter-level removal. */
function pruneTreeFolder(app: App, path: string): void {
  const entry = app.vault.getAbstractFileByPath(path);
  if (!(entry instanceof TFolder)) return;
  const siblings = entry.parent?.children;
  if (!siblings) return;
  const index = siblings.indexOf(entry);
  if (index >= 0) siblings.splice(index, 1);
}

/** Decode bytes as UTF-8 (imported manifests and docs are text). */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}
