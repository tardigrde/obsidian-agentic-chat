import type { App, TFile } from "obsidian";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { splitFrontmatter } from "../../vault/frontmatter";
import type { IgnoreMatcher } from "../../vault/ignore";
import { truncateToolOutput } from "../../vault/truncate";
import { SetPropertiesParameters, vaultToolDefinition } from "../vault-tool-definitions";
import { getVisibleVaultFile, textResult, untrustedTextResult } from "./shared";

type ToolResult = AgentToolResult<Record<string, unknown>>;

/** Map a note's inbound and outbound links (`vault_inspect` action `local_graph`). */
export function inspectLocalGraph(app: App, isIgnored: IgnoreMatcher, notePath: string): Promise<ToolResult> {
  const { path, file } = getVisibleVaultFile(app, isIgnored, notePath);
  const inbound = getBacklinkSources(app, file).filter((entry) => !isIgnored(entry.path));
  const outbound = getOutboundLinks(app, file.path).filter((entry) => !isIgnored(entry.path));
  const inboundLines = inbound.length === 0 ? ["  (none)"] : inbound.map((entry) => `  ${entry.path}`);
  const outboundLines = outbound.length === 0 ? ["  (none)"] : outbound.map((entry) => `  ${entry.path}`);
  const text = [`Inbound (${inbound.length}):`, ...inboundLines, `Outbound (${outbound.length}):`, ...outboundLines].join("\n");
  return Promise.resolve(textResult(truncateToolOutput(text), {
    path,
    inbound: inbound.map((entry) => entry.path),
    outbound: outbound.map((entry) => entry.path),
  }));
}

/** Read a note's frontmatter as structured data (`vault_inspect` action `properties`). */
export async function inspectProperties(app: App, isIgnored: IgnoreMatcher, notePath: string): Promise<ToolResult> {
  const { path, file } = getVisibleVaultFile(app, isIgnored, notePath);
  const frontmatter = await readFrontmatter(app, file);
  const keys = Object.keys(frontmatter);
  const text = keys.length === 0 ? "(no frontmatter properties)" : JSON.stringify(frontmatter, null, 2);
  return untrustedTextResult(truncateToolOutput(text), { path, keys }, "vault_inspect");
}

export function createSetPropertiesTool(
  app: App,
  isIgnored: IgnoreMatcher,
): AgentTool<typeof SetPropertiesParameters> {
  return {
    ...vaultToolDefinition("set_properties"),
    execute: async (_id, params) => {
      const { path, file } = getVisibleVaultFile(app, isIgnored, params.path);
      const set: string[] = [];
      const deleted: string[] = [];
      await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(params.properties)) {
          if (value === null) {
            delete frontmatter[key];
            deleted.push(key);
          } else {
            frontmatter[key] = value;
            set.push(key);
          }
        }
      });
      const parts: string[] = [];
      if (set.length > 0) parts.push(`set ${set.join(", ")}`);
      if (deleted.length > 0) parts.push(`deleted ${deleted.join(", ")}`);
      return textResult(`Updated frontmatter of ${path}: ${parts.join("; ") || "no changes"}.`, {
        path,
        set,
        deleted,
      });
    },
  };
}

/**
 * Obsidian's backlink API (`metadataCache.getBacklinksForFile`) is undocumented
 * in the public typings: it returns a structure whose `.data` maps each source
 * path to an array of link references. Newer builds expose `.data` as a Map.
 */
interface BacklinkResult {
  data?: Record<string, unknown[]> | Map<string, unknown[]>;
}

interface MetadataCacheWithBacklinks {
  getBacklinksForFile?: (file: TFile) => BacklinkResult | undefined;
}

/** Resolve inbound links to `file`, returning each source path and its ref count. */
function getBacklinkSources(app: App, file: TFile): Array<{ path: string; count: number }> {
  const cache = app.metadataCache as unknown as MetadataCacheWithBacklinks;
  const result = cache.getBacklinksForFile?.(file);
  const data = result?.data;
  if (!data) return [];
  const entries: Array<[string, unknown[]]> =
    data instanceof Map ? [...data.entries()] : Object.entries(data);
  return entries
    .map(([sourcePath, refs]) => ({ path: sourcePath, count: Array.isArray(refs) ? refs.length : 0 }))
    .filter((entry) => entry.path !== file.path)
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Resolve outbound links from `sourcePath`, returning each target path and its link count. */
function getOutboundLinks(app: App, sourcePath: string): Array<{ path: string; count: number }> {
  const targets = app.metadataCache.resolvedLinks[sourcePath] ?? {};
  return Object.entries(targets)
    .map(([targetPath, count]) => ({ path: targetPath, count: typeof count === "number" ? count : 0 }))
    .filter((entry) => entry.path !== sourcePath)
    .sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Read a note's frontmatter as structured data. Prefers the metadata cache;
 * falls back to parsing the file's leading YAML block when the cache is empty
 * (e.g. the file was just written, or in non-Obsidian test runtimes).
 */
async function readFrontmatter(app: App, file: TFile): Promise<Record<string, unknown>> {
  const cached = app.metadataCache.getFileCache(file)?.frontmatter;
  if (cached) {
    const { position: _position, ...rest } = cached as Record<string, unknown>;
    return rest;
  }
  const content = await app.vault.cachedRead(file);
  return parseFrontmatterBlock(content);
}

/** Parse the leading `---` YAML block of a note into structured data. */
function parseFrontmatterBlock(content: string): Record<string, unknown> {
  return splitFrontmatter(content, {
    flavor: "yaml",
    objectOnly: true,
    reportParseProblem: false,
  }).data;
}
