import { type App, TFolder, TFile } from "obsidian";
import type { Skill } from "@earendil-works/pi-agent-core";
import {
  createMcpServerSettings,
  type McpServerSettings,
} from "../mcp/settings";
import { parseSkillMarkdown } from "../skills/skill-format";
import { sha256Hex } from "../utils/sha256";
import {
  AGENT_PLUGINS_MCP_SCHEMA_ID,
  type PluginMcpServer,
  type PluginMcpValidation,
  type PluginManifest,
  type PluginReportItem,
  validateMcpConfig,
  validatePluginManifest,
} from "./manifest";

/** Vault folder that holds Agent Plugins packages. */
export const DEFAULT_PLUGINS_FOLDER = ".agentic-plugins";

/** Audit status of a loaded plugin. */
export type PluginAuditStatus = "ok" | "partial" | "failed";

export interface LoadedPlugin {
  /** Vault path of the plugin package directory, e.g. ".agentic-plugins/my-plugin". */
  rootPath: string;
  /** Manifest name. */
  name: string;
  version?: string;
  description?: string;
  /** Per-plugin enable toggle from settings; disabled plugins are not loaded into the runtime. */
  enabled: boolean;
  /** Fatal manifest violation; when set nothing from the plugin is usable. */
  manifestProblem: string | null;
  /** Skills discovered from `skills/<name>/SKILL.md`. */
  skills: Skill[];
  /** Reports for skipped/invalid skills. */
  skillReports: PluginReportItem[];
  /** mcp.json validation (null when the plugin has no mcp.json). */
  mcpValidation: PluginMcpValidation | null;
  /** Derived streamable-http servers that made it through validation. */
  mcpServers: McpServerSettings[];
  /** All reports for this plugin (manifest warnings, skipped components). */
  reports: PluginReportItem[];
  auditStatus: PluginAuditStatus;
}

export interface PluginLoadOptions {
  /** Vault folder scanned for plugins (default ".agentic-plugins"). */
  folder?: string;
  /** Per-plugin enable map from settings; missing keys default to enabled. */
  enabledPlugins?: Record<string, boolean>;
}

/**
 * Discover + load Agent Plugins packages from a vault folder.
 * Missing folder is valid absence (§6.2). A fatal manifest violation rejects
 * that plugin only; failures inside a plugin never affect other plugins.
 */
export async function loadPlugins(app: App, options: PluginLoadOptions = {}): Promise<LoadedPlugin[]> {
  const folder = options.folder ?? DEFAULT_PLUGINS_FOLDER;
  // Minimal test harnesses only stub vault.on(); treat that as an absent folder.
  if (typeof app.vault.getAbstractFileByPath !== "function") return [];
  const dirs = await listPluginDirectories(app, folder);
  const plugins: LoadedPlugin[] = [];
  for (const dirPath of dirs) {
    plugins.push(await loadPluginDir(app, dirPath, options.enabledPlugins ?? {}));
  }
  return plugins;
}

/**
 * Immediate subdirectories of the plugins folder. The vault file tree is the
 * fast path, but its `children` can be stale (brand-new dot folders, external
 * sync the watcher has not indexed yet), so adapter-discovered directories
 * are merged in deterministically. Missing folder is valid absence (§6.2).
 */
async function listPluginDirectories(app: App, folder: string): Promise<string[]> {
  const root = folderEntry(app, folder);
  const dirs = new Set<string>();
  if (root) {
    for (const child of root.children ?? []) {
      if (child instanceof TFolder) dirs.add(child.path);
    }
  }
  try {
    const listing = await app.vault.adapter.list(folder);
    for (const entry of listing?.folders ?? []) {
      const normalized = trimEdges(entry, (char) => char !== "/");
      if (normalized) dirs.add(normalized);
    }
  } catch {
    // Adapter unavailable or folder absent; tree results (if any) still stand.
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

async function loadPluginDir(
  app: App,
  rootPath: string,
  enabledPlugins: Record<string, boolean>,
): Promise<LoadedPlugin> {
  const segments = rootPath.split("/");
  const dirName = segments[segments.length - 1] ?? rootPath;
  const validation = await readPluginManifest(app, rootPath);
  const reports: PluginReportItem[] = [];
  if (validation.fatal) {
    reports.push({ severity: "error", message: validation.fatal });
    return {
      rootPath,
      name: dirName,
      manifestProblem: validation.fatal,
      enabled: enabledPlugins[dirName] !== false,
      skills: [],
      skillReports: [],
      mcpValidation: null,
      mcpServers: [],
      reports,
      auditStatus: "failed",
    };
  }

  reports.push(...validation.reports);
  const parsed = validation.manifest as PluginManifest;

  const { skills, skillReports } = await loadPluginSkills(app, rootPath, reports);
  const { mcpValidation, mcpServers } = await loadPluginMcp(app, rootPath, parsed.name, reports);

  const enabled = enabledPlugins[parsed.name] !== false;
  const status: PluginAuditStatus =
    skillReports.length > 0 || (mcpValidation !== null && (!mcpValidation.ok || mcpValidation.servers.length === 0))
      ? "partial"
      : "ok";
  return {
    rootPath,
    name: parsed.name,
    ...(parsed.version ? { version: parsed.version } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
    enabled,
    manifestProblem: null,
    skills,
    skillReports,
    mcpValidation,
    mcpServers,
    reports,
    auditStatus: status,
  };
}

async function readPluginManifest(
  app: App,
  rootPath: string,
): Promise<{ manifest: PluginManifest | null; fatal: string | null; reports: PluginReportItem[] }> {
  const raw = await readVaultFile(app, `${rootPath}/plugin.json`);
  if (raw === null) {
    const message = "plugin.json is missing; the plugin root must contain a manifest.";
    return { manifest: null, fatal: message, reports: [{ severity: "error", message }] };
  }
  const validation = validatePluginManifest(raw);
  return {
    manifest: validation.manifest,
    fatal: validation.fatal,
    reports: validation.reports,
  };
}

/**
 * Discover skills from `skills/<name>/SKILL.md`. Per §7.1 only immediate child
 * directories containing a SKILL.md are treated as skills; invalid skills are
 * skipped and reported without affecting the rest of the plugin.
 */
async function loadPluginSkills(
  app: App,
  rootPath: string,
  reports: PluginReportItem[],
): Promise<{ skills: Skill[]; skillReports: PluginReportItem[] }> {
  const skillsPath = `${rootPath}/skills`;
  const skillsEntry = app.vault.getAbstractFileByPath(skillsPath);
  if (skillsEntry && !(skillsEntry instanceof TFolder)) {
    const message = `skills/ exists but is not a directory; skills are disabled for this plugin.`;
    reports.push({ severity: "error", message });
    return { skills: [], skillReports: [{ severity: "error", message }] };
  }
  const entries = await listSubdirectories(app, skillsPath);
  const skillReports: PluginReportItem[] = [];
  const skills: Skill[] = [];
  for (const dirPath of entries) {
    const segments = dirPath.split("/");
    const dirName = segments[segments.length - 1] ?? dirPath;
    const raw = await readVaultFile(app, `${dirPath}/SKILL.md`);
    if (raw === null) {
      const message = `skills/${dirName}/SKILL.md is missing; skill skipped.`;
      skillReports.push({ severity: "error", message });
      reports.push({ severity: "error", message });
      continue;
    }
    const parsed = parseSkillMarkdown(raw, `${dirPath}/SKILL.md`);
    if (!parsed.skill) {
      const message = `skills/${dirName}/SKILL.md: ${parsed.problems.join(" ")} Skill skipped.`;
      skillReports.push({ severity: "error", message });
      reports.push({ severity: "error", message });
      continue;
    }
    if (parsed.skill.name !== dirName.normalize("NFKC")) {
      const message = `skills/${dirName}/SKILL.md: name "${parsed.skill.name}" must match the skill directory name; skill skipped.`;
      skillReports.push({ severity: "error", message });
      reports.push({ severity: "error", message });
      continue;
    }
    skills.push(parsed.skill);
  }
  return { skills, skillReports };
}

/**
 * Discover + validate mcp.json. Missing mcp.json is valid absence (§6.2).
 * Invalid top-level disables MCP for this plugin only; invalid or unsupported
 * entries are skipped individually. Only streamable-http servers are derived.
 */
async function loadPluginMcp(
  app: App,
  rootPath: string,
  pluginName: string,
  reports: PluginReportItem[],
): Promise<{ mcpValidation: PluginMcpValidation | null; mcpServers: McpServerSettings[] }> {
  const mcpPath = `${rootPath}/mcp.json`;
  const mcpEntry = app.vault.getAbstractFileByPath(mcpPath);
  if (mcpEntry && !(mcpEntry instanceof TFile)) {
    const message = "mcp.json exists but is not a file; MCP is disabled for this plugin.";
    reports.push({ severity: "error", message });
    return { mcpValidation: null, mcpServers: [] };
  }
  const raw = await readVaultFile(app, mcpPath);
  if (raw === null) {
    return { mcpValidation: null, mcpServers: [] };
  }
  const validation = validateMcpConfig(raw, AGENT_PLUGINS_MCP_SCHEMA_ID);
  for (const report of validation.reports) reports.push(report);
  if (!validation.ok) {
    const message = validation.reason ?? "mcp.json is invalid.";
    reports.push({ severity: "error", message });
  }
  const mcpServers = validation.servers
    .filter((entry) => isDerivableServer(entry))
    .map((entry) => mcpServerFromPluginEntry(pluginName, rootPath, entry));
  return { mcpValidation: validation, mcpServers };
}

/** A server entry becomes a derived server only when valid AND transport is supported. */
function isDerivableServer(entry: PluginMcpServer): boolean {
  return entry.transport === "streamable-http" && entry.problems.length === 0 && Boolean(entry.url);
}

/** Stable id: plugin name + entry key, namespaced so it cannot collide with user ids. */
export function pluginMcpServerId(pluginName: string, entryKey: string): string {
  const raw = `plugin:${pluginName}:${entryKey}`;
  const slug = trimEdges(
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 19),
    (char) => char !== "_",
  );
  // Distinct (plugin, key) pairs can sanitize to the same slug (separators,
  // casing, and the 32-char cap in normalizeMcpServerId all collapse), so the
  // readable part is disambiguated with a truncated SHA-256 of the raw pair.
  return `${slug}_${stableIdHash(raw)}`;
}

/** Truncated SHA-256 hex; stable across reloads and machines. */
function stableIdHash(input: string): string {
  return sha256Hex(input).slice(0, 12);
}

export function mcpServerFromPluginEntry(
  pluginName: string,
  pluginRoot: string,
  entry: PluginMcpServer,
): McpServerSettings {
  return {
    ...createMcpServerSettings({
      id: pluginMcpServerId(pluginName, entry.key),
      name: `${pluginName}: ${entry.key}`,
      url: entry.url ?? "",
      enabled: true,
      approval: "ask",
      authType: "none",
    }),
    headers: entry.headers ?? {},
    source: "plugin",
    pluginRoot,
  };
}

/**
 * Merge derived plugin servers with persisted client-owned state. The plugin's
 * mcp.json is authoritative for url/name/headers; everything the user
 * configured (enabled, approval, auth, knownTools, oauth) is preserved by id.
 * Persisted records for servers no plugin declares anymore are dropped.
 */
export function mergePluginMcpServers(
  persisted: readonly McpServerSettings[],
  derived: readonly McpServerSettings[],
): McpServerSettings[] {
  const byId = new Map<string, McpServerSettings>();
  for (const server of persisted) byId.set(server.id, server);
  return derived.map((server) => {
    const record = byId.get(server.id);
    if (!record) return server;
    return {
      ...record,
      url: server.url,
      name: server.name,
      headers: server.headers,
      source: server.source,
      pluginRoot: server.pluginRoot,
    };
  });
}

/** Persist a client-owned record for every derived server (prunes orphans). */
export function syncMcpServers(
  settings: { mcp: { servers: McpServerSettings[] } },
  derived: readonly McpServerSettings[],
): void {
  settings.mcp.servers = mergePluginMcpServers(settings.mcp.servers, derived);
}

function folderEntry(app: App, path: string): TFolder | null {
  const entry = app.vault.getAbstractFileByPath(path);
  return entry instanceof TFolder ? entry : null;
}

function fileEntry(app: App, path: string): TFile | null {
  const entry = app.vault.getAbstractFileByPath(path);
  return entry instanceof TFile ? entry : null;
}

/** Immediate subdirectories of a vault folder, tree-first merged with the adapter. */
async function listSubdirectories(app: App, path: string): Promise<string[]> {
  const entry = folderEntry(app, path);
  const dirs = new Set<string>();
  if (entry) {
    for (const child of entry.children ?? []) {
      if (child instanceof TFolder) dirs.add(child.path);
    }
  }
  try {
    const listing = await app.vault.adapter.list(path);
    for (const entryPath of listing?.folders ?? []) {
      const normalized = trimEdges(entryPath, (char) => char !== "/");
      if (normalized) dirs.add(normalized);
    }
  } catch {
    // Adapter unavailable or folder absent; tree results (if any) still stand.
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

/** Trim leading/trailing characters that fail `keep` (regex-free, linear). */
function trimEdges(input: string, keep: (char: string) => boolean): string {
  let start = 0;
  let end = input.length;
  while (start < end && !keep(input[start] ?? "")) start += 1;
  while (end > start && !keep(input[end - 1] ?? "")) end -= 1;
  return input.slice(start, end);
}

/**
 * Read a vault file through the file tree when the tree has it (cachedRead),
 * or straight from the adapter when the tree is stale (brand-new folders,
 * external sync the watcher has not indexed yet).
 */
async function readVaultFile(app: App, path: string): Promise<string | null> {
  const file = fileEntry(app, path);
  if (file) {
    try {
      return await app.vault.cachedRead(file);
    } catch (error) {
      console.warn(`Agentic chat: could not read ${path}`, error);
    }
  }
  try {
    return await app.vault.adapter.read(path);
  } catch (error) {
    if (file) console.warn(`Agentic chat: could not read ${path} from disk`, error);
    return null;
  }
}
