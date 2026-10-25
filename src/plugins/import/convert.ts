import { parseYaml } from "obsidian";
import type { FileTree } from "./archive";
import type { SniffedCandidate } from "./sniff";
import { parseJson, skillNameFromDoc } from "./shared";

/** Subdirectories of a foreign layout that never carry loadable content. */
const FOREIGN_DIRS = new Set([
  ".git",
  ".github",
  ".claude-plugin",
  ".codex-plugin",
  ".plugin",
  ".vscode",
  "node_modules",
  "hooks",
  "integrations",
  "commands",
]);

/** Agent Skills frontmatter keys that survive an import (the full allowed set). */
const ALLOWED_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

export interface ConvertedSkill {
  /** Skill name (must match its directory per the loader). */
  name: string;
  /** Files relative to skills/<name>/, including the sanitized SKILL.md. */
  files: Map<string, Uint8Array>;
  warnings: string[];
}

export interface ConvertedMcpEntry {
  key: string;
  url: string;
  headers?: Record<string, string>;
  warnings: string[];
}

export interface ConvertedPackage {
  /** Package name from the source manifest (or the folder name). */
  name: string;
  description?: string;
  /** Version from the source manifest (defaults to "1.0.0" at write time). */
  version?: string;
  /** True when the source was already Agent Plugins 1.0.0; plugin.json passes through. */
  native: boolean;
  skills: ConvertedSkill[];
  mcpEntries: ConvertedMcpEntry[];
  /** Extra root-level files worth keeping (README, LICENSE, ...). */
  rootFiles: Map<string, Uint8Array>;
  warnings: string[];
}

const DECODER = new TextDecoder("utf-8");
const ENCODER = new TextEncoder();

export function convertToAgentPlugin(tree: FileTree, candidate: SniffedCandidate): ConvertedPackage {
  const prefix = candidate.root ? `${candidate.root}/` : "";
  const warnings: string[] = [];

  if (candidate.isAgentPlugins) {
    return convertNative(tree, prefix, candidate);
  }

  // Claude/Codex/VS Code layouts keep plugin.json under a dot-directory but
  // skills/ and other content at the repository root.
  const dotLayout =
    candidate.root !== "" && (candidate.format === "claude" || candidate.format === "codex" || candidate.format === "vscode");
  const contentPrefix = dotLayout ? "" : prefix;
  const manifestPath = dotLayout ? `${candidate.root}/plugin.json` : (candidate.manifestPath ?? `${prefix}plugin.json`);

  const manifest = manifestPath ? parseJson(tree.get(manifestPath)) : null;
  const name = manifest ? manifestName(manifest, candidate.root) : (skillNameFromDoc(tree.get(`${contentPrefix}SKILL.md`)) ?? manifestName(null, candidate.root));
  const description = manifestString(manifest, "description");
  const version = manifestString(manifest, "version");
  warnings.push(...dropWarnings(manifest));

  const skills = hasDir(tree, contentPrefix, "skills")
    ? convertSkills(tree, contentPrefix, warnings)
    : convertSingleSkill(tree, contentPrefix, name, warnings);
  const mcpEntries = convertMcp(tree, contentPrefix, manifest, warnings);
  const rootFiles = collectRootFiles(tree, contentPrefix, skills);

  return { name, description, version, native: false, skills, mcpEntries, rootFiles, warnings };
}

/** Native Agent Plugins packages: keep manifest + mcp.json verbatim, sanitize skills. */
function convertNative(tree: FileTree, prefix: string, candidate: SniffedCandidate): ConvertedPackage {
  const warnings: string[] = [];
  const manifestBytes = tree.get(`${prefix}plugin.json`);
  const manifest = manifestBytes ? parseJson(manifestBytes) : null;
  const name = manifestName(manifest, candidate.root);
  const description = manifestString(manifest, "description");
  const version = manifestString(manifest, "version");
  const skills = hasDir(tree, prefix, "skills")
    ? convertSkills(tree, prefix, warnings)
    : hasDir(tree, prefix, "SKILL.md")
      ? convertSingleSkill(tree, prefix, name, warnings)
      : [];
  const mcpEntries = convertMcp(tree, prefix, manifest, warnings);
  const rootFiles = collectRootFiles(tree, prefix, skills);
  return { name, description, version, native: true, skills, mcpEntries, rootFiles, warnings };
}

/** A package whose single skill document sits at the package root (SKILL.md). */
function convertSingleSkill(tree: FileTree, prefix: string, name: string, warnings: string[]): ConvertedSkill[] {
  const doc = tree.get(`${prefix}SKILL.md`);
  if (!doc) return [];
  const sanitized = sanitizeSkillDoc(DECODER.decode(doc), name, warnings);
  const files: Map<string, Uint8Array> = new Map([["SKILL.md", ENCODER.encode(sanitized)]]);
  for (const [path, bytes] of tree) {
    if (!path.startsWith(prefix) || path === `${prefix}SKILL.md`) continue;
    const rel = prefix ? path.slice(prefix.length) : path;
    const top = rel.split("/")[0] ?? "";
    if (FOREIGN_DIRS.has(top)) continue;
    files.set(rel, bytes);
  }
  return [{ name, files, warnings: [] }];
}

/** True when any tree entry lives under `prefix + rel` (directories are implicit). */
function hasDir(tree: FileTree, prefix: string, rel: string): boolean {
  const root = `${prefix}${rel}`;
  for (const path of tree.keys()) {
    if (path === root || path.startsWith(`${root}/`)) return true;
  }
  return false;
}

/** Serialize a frontmatter value as JSON (valid YAML for scalars and collections). */
function yamlScalar(value: unknown): string {
  return JSON.stringify(value);
}

/** Copy whole skill directories (`skills/<name>/SKILL.md` + scripts/references/assets). */
function convertSkills(tree: FileTree, prefix: string, warnings: string[]): ConvertedSkill[] {
  const skills: ConvertedSkill[] = [];
  const skillDirs = new Set<string>();
  for (const path of tree.keys()) {
    if (!path.startsWith(`${prefix}skills/`)) continue;
    const rest = path.slice(`${prefix}skills/`.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      warnings.push(`Skipping non-directory entry skills/${rest}.`);
      continue;
    }
    skillDirs.add(rest.slice(0, slash));
  }
  for (const dir of [...skillDirs].sort((a, b) => a.localeCompare(b))) {
    const base = `${prefix}skills/${dir}`;
    const doc = tree.get(`${base}/SKILL.md`);
    if (!doc) {
      warnings.push(`Skipping skills/${dir}: no SKILL.md at its root.`);
      continue;
    }
    const sanitized = sanitizeSkillDoc(DECODER.decode(doc), dir, warnings);
    const files: Map<string, Uint8Array> = new Map([["SKILL.md", ENCODER.encode(sanitized)]]);
    for (const [path, bytes] of tree) {
      if (!path.startsWith(`${base}/`) || path === `${base}/SKILL.md`) continue;
      files.set(path.slice(base.length + 1), bytes);
    }
    skills.push({ name: dir, files, warnings: [] });
  }
  return skills;
}

/**
 * Rewrite a skill document's frontmatter to the Agent Skills six-field set:
 * name/description/license/compatibility/metadata/allowed-tools. Non-string
 * metadata is flattened with JSON (valid YAML). `name` is forced to the
 * directory name the loader requires.
 */
export function sanitizeSkillDoc(doc: string, dirName: string, warnings: string[]): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(doc);
  if (!match) {
    return `---\nname: ${dirName}\ndescription: ${dirName} skill.\n---\n\n${doc.trimStart()}`;
  }
  const frontmatter = parseSkillFrontmatter(match[1], dirName, warnings);
  const kept = allowedFrontmatterLines(frontmatter, dirName, warnings);
  if (!kept.some((line) => line.startsWith("name:"))) {
    kept.unshift(`name: ${yamlScalar(dirName)}`);
  }
  const body = doc.slice(match[0].length).replace(/^\r?\n/, "");
  return `---\n${kept.join("\n")}\n---\n\n${body.trimStart()}`;
}

/** Parse the frontmatter block; invalid YAML warns and falls back to an empty object. */
function parseSkillFrontmatter(yaml: string, dirName: string, warnings: string[]): Record<string, unknown> {
  try {
    // Obsidian's parseYaml (js-yaml) is the same parser the plugin uses for skills.
    const parsed = parseYaml(yaml) as unknown;
    if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    warnings.push(`skills/${dirName}/SKILL.md frontmatter is not valid YAML; rewrote it to name + description only.`);
  }
  return {};
}

/** Serialize the allowed frontmatter keys, forcing `name` to the directory name. */
function allowedFrontmatterLines(
  frontmatter: Record<string, unknown>,
  dirName: string,
  warnings: string[],
): string[] {
  const kept: string[] = [];
  for (const key of ALLOWED_FRONTMATTER_KEYS) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    if (key === "name") {
      kept.push(sanitizedNameLine(value, dirName, warnings));
      continue;
    }
    kept.push(`${key}: ${yamlScalar(value)}`);
  }
  return kept;
}

/** The forced `name:` line; warns when the source name differed from the directory name. */
function sanitizedNameLine(value: unknown, dirName: string, warnings: string[]): string {
  if (typeof value !== "string" || value !== dirName) {
    warnings.push(
      `skills/${dirName}/SKILL.md name "${typeof value === "string" ? value : JSON.stringify(value)}" renamed to the directory name "${dirName}".`,
    );
  }
  return `name: ${yamlScalar(dirName)}`;
}

/** Extract MCP server entries from the source manifest (Claude/Copilot/VS Code shapes). */
function convertMcp(
  tree: FileTree,
  prefix: string,
  manifest: Record<string, unknown> | null,
  warnings: string[],
): ConvertedMcpEntry[] {
  const servers = mcpServersObject(manifest);
  if (!servers) {
    return candidateFormatHasMcp(tree, prefix) ? convertMcpJson(tree, prefix, warnings) : [];
  }
  const entries: ConvertedMcpEntry[] = [];
  for (const [key, raw] of Object.entries(servers)) {
    const entry = manifestMcpEntry(key, raw, warnings);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** One manifest-declared `mcpServers` entry, or null when it is unusable (with a warning). */
function manifestMcpEntry(key: string, raw: unknown, warnings: string[]): ConvertedMcpEntry | null {
  if (raw === null || typeof raw !== "object") {
    warnings.push(`MCP server "${key}": entry is not an object; skipped.`);
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const type = typeof entry.type === "string" ? entry.type : "http";
  if (type === "stdio") {
    warnings.push(`MCP server "${key}": stdio servers cannot run inside Obsidian; skipped.`);
    return null;
  }
  if (type !== "http" && type !== "streamable-http") {
    warnings.push(`MCP server "${key}": transport "${type}" is unsupported; skipped.`);
    return null;
  }
  const url = typeof entry.url === "string" ? entry.url : "";
  if (!url) {
    warnings.push(`MCP server "${key}": no URL; skipped.`);
    return null;
  }
  warnUnsupportedMcpFields(key, entry, warnings);
  return {
    key,
    url: substitutePluginRoot(url),
    headers: substituteHeaders(entry.headers),
    warnings: [],
  };
}

/** Warning for manifest fields Obsidian cannot honor (the server itself still imports). */
function warnUnsupportedMcpFields(key: string, entry: Record<string, unknown>, warnings: string[]): void {
  if (typeof entry.headersHelper !== "undefined") {
    warnings.push(`MCP server "${key}": headersHelper is not supported by Obsidian; dropped.`);
  }
  if (typeof entry.disableProxy !== "undefined") {
    warnings.push(`MCP server "${key}": disableProxy is not supported by Obsidian; dropped.`);
  }
}

/** String-valued headers with plugin-root placeholders resolved. */
function substituteHeaders(headers: unknown): Record<string, string> {
  const source = headers !== null && typeof headers === "object" ? headers : {};
  return Object.fromEntries(
    Object.entries(source as Record<string, unknown>)
      .filter(([, value]) => typeof value === "string")
      .map(([name, value]) => [name, substitutePluginRoot(value as string)]),
  );
}

/** A top-level mcp.json that manifests don't reference (rare); parse it too. */
function convertMcpJson(tree: FileTree, prefix: string, warnings: string[]): ConvertedMcpEntry[] {
  const raw = tree.get(`${prefix}mcp.json`);
  const parsed = raw ? parseJson(raw) : null;
  if (raw && parsed === null) {
    warnings.push("mcp.json is not valid JSON; the file was not imported.");
  }
  const servers = parsed ? (parsed.mcpServers ?? parsed.servers) : null;
  if (servers === null || (typeof servers === "object" && Object.keys(servers).length === 0)) {
    if (raw) warnings.push("mcp.json declares no MCP servers; the file was not imported.");
    return [];
  }
  if (typeof servers !== "object") return [];
  return Object.entries(servers as Record<string, unknown>)
    .map(([key, value]) => mcpJsonEntry(key, value, warnings))
    .filter((entry): entry is ConvertedMcpEntry => entry !== null);
}

/** One `mcpServers` entry from mcp.json (headers pass through unchanged). */
function mcpJsonEntry(key: string, value: unknown, warnings: string[]): ConvertedMcpEntry | null {
  const entry = value as Record<string, unknown>;
  const url = typeof entry.url === "string" ? entry.url : "";
  if (!url) {
    warnings.push(`MCP server "${key}": no URL; skipped.`);
    return null;
  }
  return {
    key,
    url: substitutePluginRoot(url),
    headers:
      entry.headers && typeof entry.headers === "object"
        ? (entry.headers as Record<string, unknown> as Record<string, string>)
        : undefined,
    warnings: [],
  };
}

/** The `mcpServers` object in any manifest shape (Claude/Copilot/VS Code all nest it). */
function mcpServersObject(manifest: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!manifest) return null;
  const direct = manifest.mcpServers;
  if (direct !== null && typeof direct === "object") return direct as Record<string, unknown>;
  const mcp = manifest.mcp;
  if (mcp !== null && typeof mcp === "object") {
    const nested = (mcp as Record<string, unknown>).servers;
    if (nested !== null && typeof nested === "object") return nested as Record<string, unknown>;
  }
  return null;
}

function candidateFormatHasMcp(tree: FileTree, prefix: string): boolean {
  return tree.has(`${prefix}mcp.json`);
}

/** ${CLAUDE_PLUGIN_ROOT} (and friends) resolve to the package dir at runtime. */
function substitutePluginRoot(value: string): string {
  return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, "${PLUGIN_ROOT}");
}

/** Warnings for manifest fields the Agent Plugins format has no home for. */
function dropWarnings(manifest: Record<string, unknown> | null): string[] {
  if (!manifest) return [];
  const dropped: string[] = [];
  for (const key of ["displayName", "metadata", "userConfig", "dependencies", "integrations"]) {
    if (manifest[key] !== undefined) dropped.push(key);
  }
  return dropped.map((key) => `Manifest field "${key}" has no Agent Plugins equivalent; dropped.`);
}

/** Copy root-level files that are not manifest, skills, MCP, or foreign layout. */
function collectRootFiles(tree: FileTree, prefix: string, skills: ConvertedSkill[]): Map<string, Uint8Array> {
  const files: Map<string, Uint8Array> = new Map();
  const skillDirs = new Set(skills.map((skill) => `skills/${skill.name}`));
  for (const [path, bytes] of tree) {
    if (!path.startsWith(prefix) || path === `${prefix}plugin.json` || path === `${prefix}mcp.json`) continue;
    const rel = path.slice(prefix.length);
    if (!rel.includes("/")) {
      files.set(rel, bytes);
      continue;
    }
    const top = rel.split("/")[0] ?? "";
    if (FOREIGN_DIRS.has(top) || skillDirs.has(top) || top === "skills") continue;
    files.set(rel, bytes);
  }
  return files;
}

function manifestName(manifest: Record<string, unknown> | null, root: string): string {
  const name = manifestString(manifest, "name");
  if (name) return name;
  return root ? root.split("/").pop() ?? root : "plugin";
}

function manifestString(manifest: Record<string, unknown> | null, key: string): string | undefined {
  const value = manifest?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}