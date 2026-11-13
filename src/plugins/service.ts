import { type App, type DataAdapter, TFolder } from "obsidian";
import { type AgenticChatSettings } from "../settings-schema";
import { createMcpServerState, normalizeMcpServerId } from "../mcp/settings";
import { pruneMcpState } from "../mcp/server-state";
import { clearMcpPerToolApprovals } from "../agent/approval";
import { BUILTIN_SKILL_DOCS } from "../skills/builtin-skills";
import { ensureVaultFolder, ensureVaultParentFolder } from "../vault/storage";
import type { FileTree } from "./import/archive";
import { convertToAgentPlugin } from "./import/convert";
import {
  installPackage,
  scaffoldManifest,
  type InstallResult,
  type PackageWriter,
} from "./import/install";
import { collectLegacyVaultSkills } from "./import/migrate-legacy-skills";
import { sniffSource, type SniffedCandidate } from "./import/sniff";
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
  type LoadedPlugin,
} from "./loader";
import { AGENT_PLUGINS_MCP_SCHEMA_ID, AGENT_PLUGINS_SCHEMA_ID, USER_SKILLS_PACKAGE, slugifyPluginName, validatePluginManifest, validatePluginName } from "./manifest";

export { FIRST_PARTY_PACKAGE_NAMES, USER_SKILLS_PACKAGE } from "./manifest";

/**
 * The one plugin catalog players share: the runtime builds skills and MCP tools
 * from this list, and an install or vault edit invalidates it.
 */
export interface PluginCatalog {
  /**
   * The cached list, or null when no scan is cached. Read-only: it never runs
   * the reload, which prunes plugin settings and saves. The runtime scans the
   * folder itself when this is null.
   */
  peekLoaded(): LoadedPlugin[] | null;
  /** Returns an unsubscribe function. */
  onInvalidated(listener: () => void): () => void;
}

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
  /** Single-flight: concurrent reloads must not run import recovery twice. */
  private reloadInFlight: Promise<LoadedPlugin[]> | null = null;
  /** Serializes install transactions with the recovery sweep. */
  private maintenance: Promise<void> = Promise.resolve();
  private retainedImportBackup = false;
  private readonly invalidationListeners = new Set<() => void>();

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
    if (this.reloadInFlight) return this.reloadInFlight;
    const run = this.performReload();
    this.reloadInFlight = run;
    try {
      return await run;
    } finally {
      if (this.reloadInFlight === run) this.reloadInFlight = null;
    }
  }

  /**
   * Serialize the install transaction and the recovery sweep. A sweep must not
   * delete a stage an install is using, and two installs must not move the same
   * backup. A rejected operation does not block the next one.
   */
  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.maintenance.then(op, op);
    this.maintenance = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async performReload(): Promise<LoadedPlugin[]> {
    const settings = this.getSettings();
    await this.sweepImportStages();
    this.cache = await loadPlugins(this.app, {
      folder: settings.plugins.folder,
      enabledPlugins: settings.plugins.enabled,
    });
    // A retained backup still owns the state keys of its package. Pruning now
    // would drop plugin/OAuth state before the backup can be restored.
    const mutated = this.retainedImportBackup ? false : this.pruneOrphanPluginSettings(settings);
    if (mutated) await this.saveSettings?.();
    return this.cache;
  }

  /** True when the last sweep kept an import backup for manual recovery. */
  hasRetainedImportBackup(): boolean {
    return this.retainedImportBackup;
  }

  private pruneOrphanPluginSettings(settings: AgenticChatSettings): boolean {
    const aliveIds = new Set(this.cache!.flatMap((p) => p.mcpServers.map((s) => s.id)));
    // Keep mcpState for ids still owned by a legacy user server — one prune
    // rule with the settings-tab guard (prevents collision over-delete).
    const isLegacyUserId = (id: string): boolean =>
      settings.mcp.servers.some((server) => server.id === id && server.source !== "plugin");
    let mutated = pruneMcpState(settings, aliveIds, isLegacyUserId);
    const aliveNames = new Set(this.cache!.map((p) => p.name));
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
    return mutated;
  }

  getLoaded(): LoadedPlugin[] {
    return this.cache ?? [];
  }

  peekLoaded(): LoadedPlugin[] | null {
    return this.cache;
  }

  /** True while the cache holds a scanned plugin list (valid or empty). */
  hasCache(): boolean {
    return this.cache !== null;
  }

  invalidate(): void {
    this.cache = null;
    this.notifyInvalidated();
  }

  /**
   * Drop the cache when a vault path inside the plugins folder changed.
   * Returns true when the cache was invalidated for that path.
   */
  invalidateFor(path: string): boolean {
    const folder = this.pluginsFolder().replace(/\/+$/, "");
    if (path !== folder && !path.startsWith(`${folder}/`)) return false;
    this.cache = null;
    this.notifyInvalidated();
    return true;
  }

  /** Subscribe to invalidations so a runtime can rebuild plugin-derived tools. */
  onInvalidated(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }

  private notifyInvalidated(): void {
    for (const listener of [...this.invalidationListeners]) {
      try {
        listener();
      } catch (error) {
        console.warn("Agentic chat: plugin invalidation listener failed", error);
      }
    }
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
        // exists failed (permissions / transient IO) — don't treat as deleted, keep plugin visible.
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
    await ensureVaultFolder(this.app, rootPath);
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
    const { nativeManifest, nativeMcpJson } = readNativePackageFiles(tree, candidate, converted.native);
    const result = await this.runExclusive(() =>
      installPackage(this.vaultWriter(), {
        converted,
        pluginsFolder: this.pluginsFolder(),
        ...(nativeManifest ? { nativeManifest } : {}),
        ...(nativeMcpJson ? { nativeMcpJson } : {}),
      }),
    );
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

  /** Body cap for scaffolded skills (agent path has no modal textarea limit). */
  private static readonly MAX_SKILL_BODY_CHARS = 64 * 1024;

  async scaffoldSkill(
    input: { name: string; description: string; body: string },
    options: { source?: string; allowOverwrite?: boolean } = {},
  ): Promise<InstallResult> {
    if (!/[a-z0-9]/i.test(input.name)) {
      throw new Error("Skill name must contain at least one letter or digit.");
    }
    const name = slugifyPluginName(input.name);
    if (!name || !validatePluginName(name)) throw new Error("Skill name must contain at least one letter or digit.");
    if (input.body.trim().length > PluginService.MAX_SKILL_BODY_CHARS) {
      throw new Error(
        `Skill body is too large (${input.body.trim().length} chars, max ${PluginService.MAX_SKILL_BODY_CHARS}). Split it or shorten it.`,
      );
    }
    // Fail closed on collision: the writer replaces same-named packages in
    // place (unrecoverable, no undo), so the caller must opt into overwrite
    // explicitly after the user confirmed it.
    if (!options.allowOverwrite && (await this.packageExists(name))) {
      throw new Error(
        `A plugin named "${name}" already exists. Pick another name, or confirm the replacement first.`,
      );
    }
    const result = await this.runExclusive(() =>
      installPackage(this.vaultWriter(), {
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
      }),
    );
    this.recordSource(result.name, options.source ?? "New skill wizard");
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
    const serverIds = await this.serverIdsForPackage(name, rootPath);
    const existed = await this.vaultWriter().removeFolder(rootPath);
    const settings = this.getSettings();
    settings.mcp.servers = settings.mcp.servers.filter((server) => server.source !== "plugin" || server.pluginRoot !== rootPath);
    for (const id of serverIds) {
      delete settings.plugins.mcpState[id];
      clearMcpPerToolApprovals(settings.approval, id);
    }
    settings.plugins.enabled = omitKey(settings.plugins.enabled, name);
    settings.plugins.sources = omitKey(settings.plugins.sources, name);
    await this.saveSettings?.();
    this.invalidate();
    return existed;
  }

  /** Server ids owned by a package, from the cache when loaded, else from its on-disk mcp.json. */
  private async serverIdsForPackage(name: string, rootPath: string): Promise<string[]> {
    const cached =
      this.cache?.find((p) => p.rootPath === rootPath) ?? this.cache?.find((p) => p.name === name) ?? null;
    if (cached) return cached.mcpServers.map((server) => server.id);
    return this.readMcpServerIds(name, rootPath);
  }

  /** Best-effort read of the server keys a package declares in `mcp.json` (bounded). */
  private async readMcpServerIds(name: string, rootPath: string): Promise<string[]> {
    try {
      const raw = await this.app.vault.adapter.read(`${rootPath}/mcp.json`);
      if (!raw || raw.length > 128 * 1024) return [];
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const mcpServers = parsed?.mcpServers;
      if (!mcpServers || typeof mcpServers !== "object") return [];
      // Bound iteration to avoid DOS from crafted huge mcp.json
      return Object.keys(mcpServers)
        .slice(0, 100)
        .map((key) => pluginMcpServerId(name, key));
    } catch {
      // Best-effort only; orphans are also pruned on next reload() via aliveIds.
      return [];
    }
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

  /** Recreate the `builtins` package from scratch (Repair button). Also restores `my-skills` when missing. */
  async repairBuiltins(): Promise<void> {
    await this.vaultWriter().removeFolder(`${this.pluginsFolder()}/builtins`);
    await this.ensureBuiltinsMaterialized();
    await this.ensureMySkillsMaterialized();
  }

  /**
   * Materialize the user's own `my-skills` collection package. Ships empty
   * (manifest + README, no skills/, no mcp.json) — both are optional under
   * Agent Plugins §6.2, so the loader reports it `ok` with 0 skills / 0
   * servers. Only creates missing files — never overwrites user content, and
   * self-heals a half-written package (missing plugin.json or README).
   */
  async ensureMySkillsMaterialized(): Promise<boolean> {
    const writer = this.vaultWriter();
    const target = `${this.pluginsFolder()}/${USER_SKILLS_PACKAGE}`;
    await writer.ensureFolder(target);
    let created = false;
    if (!(await this.vaultFileExists(`${target}/plugin.json`))) {
      await writer.writeFile(
        `${target}/plugin.json`,
        scaffoldManifest(
          USER_SKILLS_PACKAGE,
          "Your personal skill collection. Add skills here as skills/<name>/SKILL.md; this package is never overwritten.",
        ),
      );
      created = true;
    }
    if (!(await this.vaultFileExists(`${target}/README.md`))) {
      await writer.writeFile(
        `${target}/README.md`,
        "This is your personal skill collection. Each `skills/<name>/SKILL.md` you add here becomes " +
          "an agent skill (the skill `name` frontmatter must match its folder name). " +
          "The plugin only creates this package when it is missing and never overwrites your edits.\n",
      );
      created = true;
    }
    if (created) this.invalidate();
    return created;
  }

  /** True when a vault file exists in the tree or on disk (stale-tree safe). */
  private async vaultFileExists(path: string): Promise<boolean> {
    if (this.app.vault.getAbstractFileByPath(path)) return true;
    try {
      await this.app.vault.adapter.read(path);
      return true;
    } catch {
      return false;
    }
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
      const dir = uniqueSkillDir(slugifyPluginName(skill.name) || "skill", usedDirs);
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

  /**
   * Remove leftover `.importing-*` stage folders a crashed install may have
   * left. A `.importing-backup-<name>` folder means the crash happened after
   * moving the old package aside but before the staged package landed. Restore
   * it when the target is missing or when an empty target can be safely
   * replaced; never delete the only package copy.
   *
   * One bad child must not hide every other package from the reload.
   */
  async sweepImportStages(): Promise<void> {
    return this.runExclusive(() => this.performSweepImportStages());
  }

  private async performSweepImportStages(): Promise<void> {
    const writer = this.vaultWriter();
    const backupPrefix = ".importing-backup-";
    for (const childPath of await this.importStagePaths()) {
      try {
        await this.sweepImportStage(childPath, backupPrefix, writer);
      } catch (error) {
        console.warn(`Agentic chat: could not clean import stage ${childPath}`, error);
      }
    }
    // Startup sweeps before the settings tab exists, so remember the outcome
    // here rather than only in reload().
    this.retainedImportBackup = await this.detectRetainedImportBackup();
  }

  private async sweepImportStage(childPath: string, backupPrefix: string, writer: PackageWriter): Promise<void> {
    const childName = childPath.split("/").pop() ?? "";
    if (!childName.startsWith(backupPrefix)) {
      await writer.removeFolder(childPath);
      return;
    }
    const name = childName.slice(backupPrefix.length);
    const target = `${this.pluginsFolder()}/${name}`;
    const safeName = name !== "" && name !== "." && name !== ".." && !/[/\\]/.test(name);
    if (!safeName || !this.isWithinPluginsFolder(target)) {
      await writer.removeFolder(childPath);
      return;
    }
    const kind = await this.targetKind(target);
    if (kind === "missing") {
      await writer.renameFolder(childPath, target);
      return;
    }
    if (kind === "file") return;
    if (await this.hasReadablePluginManifest(target)) {
      // A real package owns the target; the backup is replaceable.
      await writer.removeFolder(childPath);
      return;
    }
    // A folder without a readable manifest is not a package owner. Only an
    // empty folder is safe to replace; anything else may be partial user data.
    if (!(await this.isFolderEmptyOnDisk(target))) return;
    await writer.removeFolder(target);
    await writer.renameFolder(childPath, target);
  }

  /** Stage/backup folders from the tree and the adapter (tree can be stale). */
  private async importStagePaths(): Promise<string[]> {
    const paths = new Set<string>();
    const root = this.app.vault.getAbstractFileByPath(this.pluginsFolder());
    if (root instanceof TFolder) {
      for (const child of root.children ?? []) {
        if (child instanceof TFolder && child.name.startsWith(".importing-")) paths.add(child.path);
      }
    }
    try {
      const listing = await this.app.vault.adapter.list(this.pluginsFolder());
      for (const folderPath of listing?.folders ?? []) {
        const normalized = folderPath.replace(/\/+$/, "");
        const name = normalized.split("/").pop() ?? "";
        if (name.startsWith(".importing-")) paths.add(normalized);
      }
    } catch {
      // Adapter listing unavailable; tree entries (if any) still stand.
    }
    return [...paths];
  }

  private async detectRetainedImportBackup(): Promise<boolean> {
    const backupPrefix = ".importing-backup-";
    for (const path of await this.importStagePaths()) {
      const name = path.split("/").pop() ?? "";
      if (name.startsWith(backupPrefix)) return true;
    }
    return false;
  }

  /** On-disk kind at `path`: the tree may be stale, so stat decides existence. */
  private async targetKind(path: string): Promise<"folder" | "file" | "missing"> {
    const adapter = this.app.vault.adapter as DataAdapter & {
      stat?: (target: string) => Promise<{ type: "file" | "folder" } | null>;
    };
    if (typeof adapter.stat === "function") {
      try {
        const stat = await adapter.stat(path);
        if (!stat) return "missing";
        return stat.type === "folder" ? "folder" : "file";
      } catch {
        // stat failure is not proof of absence; fall through to exists.
      }
    }
    try {
      if (!(await adapter.exists(path))) return "missing";
    } catch {
      // Unknown state: keep the backup instead of renaming over something.
      return "file";
    }
    const entry = this.app.vault.getAbstractFileByPath(path);
    if (entry instanceof TFolder) return "folder";
    if (entry) return "file";
    try {
      await adapter.list(path);
      return "folder";
    } catch {
      return "file";
    }
  }

  private async hasReadablePluginManifest(target: string): Promise<boolean> {
    try {
      const raw = await this.app.vault.adapter.read(`${target}/plugin.json`);
      return raw.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async isFolderEmptyOnDisk(path: string): Promise<boolean> {
    try {
      const listing = await this.app.vault.adapter.list(path);
      return (listing?.folders?.length ?? 0) === 0 && (listing?.files?.length ?? 0) === 0;
    } catch {
      return false;
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
      ensureFolder: async (path) => ensureVaultFolder(this.app, path),
      writeFile: async (path, content) => {
        await ensureVaultParentFolder(this.app, path);
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
        if (!this.isWithinPluginsFolder(path)) return false;
        const inTree = app.vault.getAbstractFileByPath(path) instanceof TFolder;
        const onDisk = await app.vault.adapter.exists(path).catch(() => false);
        if (!inTree && !onDisk) return false;
        try {
          await app.vault.adapter.rmdir(path, true);
        } catch (error) {
          const code = (error as { code?: string })?.code;
          const message = String((error as Error)?.message ?? "").toLowerCase();
          if (code === "ENOENT" || message.includes("enoent")) return false;
          throw error;
        }
        pruneTreeFolder(app, path);
        return true;
      },
      folderExists: async (path) => {
        const entry = app.vault.getAbstractFileByPath(path);
        if (entry) return entry instanceof TFolder;
        const adapter = app.vault.adapter as DataAdapter & {
          stat?: (target: string) => Promise<{ type: "file" | "folder" } | null>;
        };
        if (typeof adapter.stat !== "function") return false;
        try {
          const stat = await adapter.stat(path);
          return stat?.type === "folder";
        } catch {
          return false;
        }
      },
      renameFolder: async (from, to) => {
        await app.vault.adapter.rename(from, to);
      },
    };
  }

  private pluginsFolder(): string {
    const raw = this.getSettings().plugins.folder.trim().replace(/\/+$/, "");
    if (!raw) return DEFAULT_PLUGINS_FOLDER;
    if (raw.startsWith("/") || raw.includes(":") || raw.includes("\\")) return DEFAULT_PLUGINS_FOLDER;
    const segments = raw.split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === ".." || segment === ".")) {
      return DEFAULT_PLUGINS_FOLDER;
    }
    return raw;
  }

  private isWithinPluginsFolder(target: string): boolean {
    if (!target || target === "/" || target.trim() === "") return false;
    const folder = this.pluginsFolder().replace(/\/+$/, "");
    const normalized = target.trim().replace(/\/+$/, "");
    if (normalized === folder) return false;
    if (!normalized.startsWith(`${folder}/`)) return false;
    // No traversal segments after the plugins folder prefix
    const suffix = normalized.slice(folder.length + 1);
    if (!suffix || suffix.split("/").some((segment) => segment === ".." || segment === "." || segment.length === 0)) return false;
    return true;
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

/** First free directory name in `usedDirs`: `base`, then `base-2`, `base-3`, ... */
function uniqueSkillDir(base: string, usedDirs: Set<string>): string {
  let dir = base;
  let suffix = 2;
  while (usedDirs.has(dir)) {
    dir = `${base}-${suffix}`;
    suffix += 1;
  }
  return dir;
}

/** Copy a record without `key` (no in-place mutation of the settings object). */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/**
 * Verbatim native-package files, validated before they are written. A bad
 * manifest fails the import instead of landing in the vault and being
 * rejected by the loader on the next scan.
 */
function readNativePackageFiles(
  tree: FileTree,
  candidate: SniffedCandidate,
  native: boolean,
): { nativeManifest?: string; nativeMcpJson?: string } {
  if (!native) return {};
  const manifestPath = candidate.manifestPath ?? (candidate.root ? `${candidate.root}/plugin.json` : "plugin.json");
  const manifestBytes = tree.get(manifestPath);
  if (!manifestBytes) throw new Error("The native plugin package has no plugin.json to install.");
  const nativeManifest = decodeUtf8(manifestBytes);
  const validation = validatePluginManifest(nativeManifest);
  if (validation.fatal) {
    throw new Error(`The plugin package's plugin.json is invalid: ${validation.fatal}`);
  }
  const mcpBytes = tree.get(`${candidate.root ? `${candidate.root}/` : ""}mcp.json`);
  return mcpBytes ? { nativeManifest, nativeMcpJson: decodeUtf8(mcpBytes) } : { nativeManifest };
}
