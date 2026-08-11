import { type App, TFolder, TFile } from "obsidian";
import type { Skill } from "@earendil-works/pi-agent-core";
import {
  createMcpServerSettings,
  normalizeMcpServerId,
  type McpServerSettings,
} from "../mcp/settings";
import { parseSkillMarkdown } from "../skills/skill-format";
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
  const root = folderEntry(app, folder);
  if (!root) return [];
  const pluginDirs = (root.children ?? []).filter((child): child is TFolder => child instanceof TFolder);
  const plugins: LoadedPlugin[] = [];
  for (const dir of pluginDirs.sort((a, b) => a.path.localeCompare(b.path))) {
    plugins.push(await loadPluginDir(app, dir, folder, options.enabledPlugins ?? {}));
  }
  return plugins;
}

async function loadPluginDir(
  app: App,
  dir: TFolder,
  baseFolder: string,
  enabledPlugins: Record<string, boolean>,
): Promise<LoadedPlugin> {
  const rootPath = dir.path;
  const validation = await readPluginManifest(app, rootPath);
  const reports: PluginReportItem[] = [];
  if (validation.fatal) {
    reports.push({ severity: "error", message: validation.fatal });
    return {
      rootPath,
      name: dir.name,
      manifestProblem: validation.fatal,
      enabled: enabledPlugins[dir.name] !== false,
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
  const file = fileEntry(app, `${rootPath}/plugin.json`);
  if (!file) {
    const message = "plugin.json is missing; the plugin root must contain a manifest.";
    return { manifest: null, fatal: message, reports: [{ severity: "error", message }] };
  }
  const raw = await readFile(app, file);
  if (raw === null) {
    const message = "plugin.json could not be read.";
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
  const skillsDir = folderEntry(app, skillsPath);
  if (!skillsDir) return { skills: [], skillReports: [] };
  const skillReports: PluginReportItem[] = [];
  const skills: Skill[] = [];
  const entries = (skillsDir.children ?? []).filter((child): child is TFolder => child instanceof TFolder);
  for (const dir of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    const skillFile = fileEntry(app, `${dir.path}/SKILL.md`);
    if (!skillFile) {
      const message = `skills/${dir.name}/SKILL.md is missing; skill skipped.`;
      skillReports.push({ severity: "error", message });
      reports.push({ severity: "error", message });
      continue;
    }
    const raw = await readFile(app, skillFile);
    if (raw === null) {
      const message = `skills/${dir.name}/SKILL.md could not be read; skill skipped.`;
      skillReports.push({ severity: "error", message });
      reports.push({ severity: "error", message });
      continue;
    }
    const parsed = parseSkillMarkdown(raw, skillFile.path);
    if (!parsed.skill) {
      const message = `skills/${dir.name}/SKILL.md: ${parsed.problems.join(" ")} Skill skipped.`;
      skillReports.push({ severity: "error", message });
      reports.push({ severity: "error", message });
      continue;
    }
    if (parsed.skill.name !== dir.name) {
      const message = `skills/${dir.name}/SKILL.md: name "${parsed.skill.name}" must match the skill directory name; skill skipped.`;
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
  const mcpFile = fileEntry(app, mcpPath);
  if (!mcpFile) return { mcpValidation: null, mcpServers: [] };
  const raw = await readFile(app, mcpFile);
  if (raw === null) {
    const message = "mcp.json could not be read; MCP is disabled for this plugin.";
    reports.push({ severity: "error", message });
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
  return normalizeMcpServerId(`plugin:${pluginName}:${entryKey}`);
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

async function readFile(app: App, file: TFile): Promise<string | null> {
  try {
    return await app.vault.cachedRead(file);
  } catch (error) {
    console.warn(`Agentic chat: could not read ${file.path}`, error);
    return null;
  }
}
