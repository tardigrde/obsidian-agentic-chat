import type { App } from "obsidian";
import { type AgenticChatSettings } from "../settings-schema";
import { normalizeMcpServerId } from "../mcp/settings";
import type { FileTree } from "./import/archive";
import { convertToAgentPlugin } from "./import/convert";
import { installPackage, type InstallResult } from "./import/install";
import { sniffSource, type SniffedCandidate } from "./import/sniff";
import {
  createObsidianBytesFetcher,
  parseImportSource,
  resolveImportSource,
  type ImportBytesFetcher,
} from "./import/url-source";
import { loadPlugins, mcpServerFromPluginEntry, type LoadedPlugin } from "./loader";
import { validatePluginManifest } from "./manifest";
import { sweepImportStages } from "./import-sweep";
import {
  materializeBuiltins,
  materializeLegacySkills,
  materializeMySkills,
  removeBuiltins,
  scaffoldSkillPackage,
  writeMcpServerPackage,
  type McpServerPackage,
} from "./materialize";
import { PluginVault, decodeUtf8 } from "./plugin-vault";
import {
  enableGeneratedMcpServer,
  forgetPluginPackage,
  pruneOrphanPluginSettings,
  recordImportedMcpState,
  recordPluginSource,
} from "./plugin-settings-records";

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

export type GenerateMcpPackageResult = McpServerPackage;

/**
 * Owns the Agent Plugins catalog: the cached scan, its invalidation
 * listeners, and the order of every operation that changes the plugins folder.
 *
 * - Vault I/O, confined to the plugins folder: {@link PluginVault}.
 * - Crash recovery of interrupted installs: `sweepImportStages`.
 * - Packages the plugin writes itself: `materialize.ts`.
 * - Plugin-owned settings: `plugin-settings-records.ts`.
 *
 * Install transactions and the recovery sweep share one lock, so a sweep never
 * deletes a stage an install is using. Reloads are single-flight. Every
 * operation that changes a package invalidates the cache once it has landed.
 */
export class PluginService {
  private cache: LoadedPlugin[] | null = null;
  /** Single-flight: concurrent reloads must not run import recovery twice. */
  private reloadInFlight: Promise<LoadedPlugin[]> | null = null;
  /** Serializes install transactions with the recovery sweep. */
  private maintenance: Promise<void> = Promise.resolve();
  private retainedImportBackup = false;
  private readonly invalidationListeners = new Set<() => void>();
  private readonly vault: PluginVault;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => AgenticChatSettings,
    private readonly saveSettings?: () => void | Promise<void>,
  ) {
    this.vault = new PluginVault(app, () => this.getSettings().plugins.folder);
  }

  // ---------------------------------------------------------------------------
  // The catalog
  // ---------------------------------------------------------------------------

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

  private async performReload(): Promise<LoadedPlugin[]> {
    const settings = this.getSettings();
    await this.sweepImportStages();
    const plugins = await loadPlugins(this.app, {
      folder: settings.plugins.folder,
      enabledPlugins: settings.plugins.enabled,
    });
    this.cache = plugins;
    // A retained backup still owns the state keys of its package. Pruning now
    // would drop plugin/OAuth state before the backup can be restored.
    const mutated = this.retainedImportBackup ? false : pruneOrphanPluginSettings(settings, plugins);
    if (mutated) await this.saveSettings?.();
    return plugins;
  }

  /** True when the last sweep kept an import backup for manual recovery. */
  hasRetainedImportBackup(): boolean {
    return this.retainedImportBackup;
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
    if (!this.vault.isAtOrBelow(path)) return false;
    this.invalidate();
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

  // ---------------------------------------------------------------------------
  // Operations that change the plugins folder
  // ---------------------------------------------------------------------------

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

  /** Recover from interrupted installs; see `sweepImportStages`. */
  async sweepImportStages(): Promise<void> {
    return this.runExclusive(async () => {
      // Startup sweeps before the settings tab exists, so remember the outcome
      // here rather than only in reload().
      this.retainedImportBackup = await sweepImportStages(this.vault);
    });
  }

  /**
   * Write a real Agent Plugins package for a single remote MCP server, so
   * users never have to hand-author files. MCP-only plugins are valid (§6.2).
   */
  async generateMcpServerPackage(input: { serverName: string; url: string }): Promise<GenerateMcpPackageResult> {
    const serverKey = normalizeMcpServerId(input.serverName) || "mcp";
    const written = await writeMcpServerPackage(this.vault, { ...input, serverKey });
    // The vault file tree may not reflect brand-new folders immediately (or
    // at all on some platforms), so don't wait for a reload to expose the
    // server: ensure a client-owned entry exists in the state map keyed by the
    // stable id the loader will derive on its next scan.
    const derived = mcpServerFromPluginEntry(written.pluginName, written.rootPath, {
      key: serverKey,
      transport: "streamable-http",
      url: input.url,
      headers: {},
      problems: [],
    });
    enableGeneratedMcpServer(this.getSettings(), derived);
    await this.saveSettings?.();
    this.invalidate();
    return written;
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
      installPackage(this.vault.writer(), {
        converted,
        pluginsFolder: this.vault.folder(),
        ...(nativeManifest ? { nativeManifest } : {}),
        ...(nativeMcpJson ? { nativeMcpJson } : {}),
      }),
    );
    const settings = this.getSettings();
    recordPluginSource(settings, result.name, label);
    // The source label is always new, so the install always saves once.
    recordImportedMcpState(settings, result.name, converted.mcpEntries);
    await this.saveSettings?.();
    this.invalidate();
    return result;
  }

  /** True when a package with this exact name is already installed. */
  async packageExists(name: string): Promise<boolean> {
    return this.vault.writer().folderExists(`${this.vault.folder()}/${name}`);
  }

  /**
   * Scaffold a single-skill package from the New skill wizard: a spec-valid
   * plugin.json + skills/<name>/SKILL.md, installed through the same writer.
   */
  async scaffoldSkill(
    input: { name: string; description: string; body: string },
    options: { source?: string; allowOverwrite?: boolean } = {},
  ): Promise<InstallResult> {
    const converted = scaffoldSkillPackage(input);
    // Fail closed on collision: the writer replaces same-named packages in
    // place (unrecoverable, no undo), so the caller must opt into overwrite
    // explicitly after the user confirmed it.
    if (!options.allowOverwrite && (await this.packageExists(converted.name))) {
      throw new Error(
        `A plugin named "${converted.name}" already exists. Pick another name, or confirm the replacement first.`,
      );
    }
    const result = await this.runExclusive(() =>
      installPackage(this.vault.writer(), { converted, pluginsFolder: this.vault.folder() }),
    );
    recordPluginSource(this.getSettings(), result.name, options.source ?? "New skill wizard");
    await this.saveSettings?.();
    this.invalidate();
    return result;
  }

  /**
   * Remove a package and prune its plugin-sourced MCP records. The vault
   * folder is derived from `rootPath` (the loader's reported package path),
   * not the manifest name: a folder may legitimately differ from the name.
   * Returns true when the folder existed on disk and was removed, false when
   * it was already absent (externally deleted).
   */
  async removePackage(name: string, rootPath: string): Promise<boolean> {
    // Determine server ids to prune before the folder is gone (cache miss → read mcp.json).
    const serverIds = await this.serverIdsForPackage(name, rootPath);
    const existed = await this.vault.writer().removeFolder(rootPath);
    forgetPluginPackage(this.getSettings(), name, rootPath, serverIds);
    await this.saveSettings?.();
    this.invalidate();
    return existed;
  }

  /** Server ids owned by a package, from the cache when loaded, else from its on-disk mcp.json. */
  private async serverIdsForPackage(name: string, rootPath: string): Promise<string[]> {
    const cached =
      this.cache?.find((p) => p.rootPath === rootPath) ?? this.cache?.find((p) => p.name === name) ?? null;
    if (cached) return cached.mcpServers.map((server) => server.id);
    return this.vault.readMcpServerIds(name, rootPath);
  }

  /** Materialize the `builtins` package when absent; never overwrites user edits. */
  async ensureBuiltinsMaterialized(): Promise<boolean> {
    const created = await materializeBuiltins(this.vault);
    if (created) this.invalidate();
    return created;
  }

  /** Recreate the `builtins` package from scratch (Repair button). Also restores `my-skills` when missing. */
  async repairBuiltins(): Promise<void> {
    await removeBuiltins(this.vault);
    await this.ensureBuiltinsMaterialized();
    await this.ensureMySkillsMaterialized();
  }

  /** Materialize the user's `my-skills` package; only creates missing files. */
  async ensureMySkillsMaterialized(): Promise<boolean> {
    const created = await materializeMySkills(this.vault);
    if (created) this.invalidate();
    return created;
  }

  /** One-time migration of legacy skills/templates folders into a `legacy-skills` package. */
  async materializeLegacySkills(folders: string[]): Promise<boolean> {
    const created = await materializeLegacySkills(this.vault, folders);
    if (created) this.invalidate();
    return created;
  }
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
