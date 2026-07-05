import { type App, TFile, TFolder, MarkdownView, parseYaml } from "obsidian";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { applyExactEdits } from "../vault/edit";
import { getParentPath, normalizeFolderPath, normalizeVaultPath } from "../vault/path";
import type { IgnoreMatcher } from "../vault/ignore";
import { formatGrepMatches, grepContent, matchesFindPattern, type GrepMatch } from "../vault/search";
import { alreadyReadMessage, type ReadMemo } from "../vault/read-memo";
import {
  formatTextSlice,
  readSizeGuardrail,
  resolveLineWindow,
  sliceTextByLines,
  truncateToolOutput,
} from "../vault/truncate";
import {
  builtinToolContractsForSurface,
  type BuiltinToolName,
  type BuiltinToolSurface,
} from "./tool-contracts";
import {
  ActiveNoteParameters,
  BacklinksParameters,
  DeleteParameters,
  EditParameters,
  FindParameters,
  GetPropertiesParameters,
  GrepParameters,
  LinksParameters,
  LocalGraphParameters,
  LsParameters,
  ReadParameters,
  RenameParameters,
  SearchParameters,
  SetPropertiesParameters,
  VaultInspectParameters,
  WriteParameters,
  vaultToolDefinition,
} from "./vault-tool-definitions";

export { MUTATING_TOOLS } from "./tool-contracts";

const TEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "jsonl", "csv", "tsv", "yaml", "yml",
  "css", "js", "ts", "tsx", "jsx", "html", "xml",
]);

/**
 * All built-in vault tools, bound to the active Obsidian app.
 *
 * `isIgnored` makes paths invisible to the agent: ignored files cannot be read,
 * listed, searched, or mutated, and report as "not found" so the model cannot
 * even infer their existence. Defaults to a permit-all matcher.
 */
export interface CreateVaultToolsOptions {
  surface?: BuiltinToolSurface;
}

export function createVaultTools(
  app: App,
  isIgnored: IgnoreMatcher = () => false,
  memo?: ReadMemo,
  options: CreateVaultToolsOptions = {},
): AgentTool[] {
  const context: VaultToolFactoryContext = { app, isIgnored, memo };
  return builtinToolContractsForSurface(options.surface).map((contract) => VAULT_TOOL_FACTORIES[contract.name](context));
}

interface VaultToolFactoryContext {
  app: App;
  isIgnored: IgnoreMatcher;
  memo?: ReadMemo;
}

const VAULT_TOOL_FACTORIES: Record<BuiltinToolName, (context: VaultToolFactoryContext) => AgentTool> = {
  read: ({ app, isIgnored, memo }) => createReadTool(app, isIgnored, memo),
  vault_inspect: ({ app, isIgnored }) => createVaultInspectTool(app, isIgnored),
  write: ({ app, isIgnored, memo }) => createWriteTool(app, isIgnored, memo),
  edit: ({ app, isIgnored, memo }) => createEditTool(app, isIgnored, memo),
  ls: ({ app, isIgnored }) => createLsTool(app, isIgnored),
  search: ({ app, isIgnored }) => createSearchTool(app, isIgnored),
  find: ({ app, isIgnored }) => createFindTool(app, isIgnored),
  grep: ({ app, isIgnored }) => createGrepTool(app, isIgnored),
  get_active_note: ({ app, isIgnored }) => createActiveNoteTool(app, isIgnored),
  rename: ({ app, isIgnored, memo }) => createRenameTool(app, isIgnored, memo),
  delete: ({ app, isIgnored, memo }) => createDeleteTool(app, isIgnored, memo),
  get_backlinks: ({ app, isIgnored }) => createBacklinksTool(app, isIgnored),
  get_links: ({ app, isIgnored }) => createLinksTool(app, isIgnored),
  local_graph: ({ app, isIgnored }) => createLocalGraphTool(app, isIgnored),
  get_properties: ({ app, isIgnored }) => createGetPropertiesTool(app, isIgnored),
  set_properties: ({ app, isIgnored }) => createSetPropertiesTool(app, isIgnored),
};

type VaultInspectAction = "list" | "search" | "active_note" | "local_graph" | "properties";

function createVaultInspectTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof VaultInspectParameters> {
  return {
    ...vaultToolDefinition("vault_inspect"),
    execute: async (id, params, signal) => {
      const action = normalizeVaultInspectAction(params.action);
      switch (action) {
        case "list":
          return runInspectedTool(createLsTool(app, isIgnored), id, { path: params.path }, action, "ls", signal);
        case "search":
          return runInspectedTool(
            createSearchTool(app, isIgnored),
            id,
            {
              query: requiredString(params.query, "query"),
              kind: params.kind,
              path: params.path,
              caseSensitive: params.caseSensitive,
              regex: params.regex,
              maxResults: params.maxResults,
              maxMatches: params.maxMatches,
            },
            action,
            "search",
            signal,
          );
        case "active_note":
          return runInspectedTool(
            createActiveNoteTool(app, isIgnored),
            id,
            { includeContent: params.includeContent, includeSelection: params.includeSelection },
            action,
            "get_active_note",
            signal,
          );
        case "local_graph":
          return runInspectedTool(
            createLocalGraphTool(app, isIgnored),
            id,
            { path: requiredString(params.path, "path") },
            action,
            "local_graph",
            signal,
          );
        case "properties":
          return runInspectedTool(
            createGetPropertiesTool(app, isIgnored),
            id,
            { path: requiredString(params.path, "path") },
            action,
            "get_properties",
            signal,
          );
      }
    },
  };
}

async function runInspectedTool(
  tool: AgentTool,
  id: string,
  params: unknown,
  action: VaultInspectAction,
  delegatedTool: BuiltinToolName,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const result = await tool.execute(id, params as never, signal);
  return {
    ...result,
    details: {
      inspectAction: action,
      delegatedTool,
      ...((result.details ?? {}) as Record<string, unknown>),
    },
  };
}

function normalizeVaultInspectAction(value: unknown): VaultInspectAction {
  if (
    value === "list" ||
    value === "search" ||
    value === "active_note" ||
    value === "local_graph" ||
    value === "properties"
  ) {
    return value;
  }
  throw new Error("vault_inspect: action must be list, search, active_note, local_graph, or properties.");
}

function requiredString(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`vault_inspect: ${name} is required.`);
  return text;
}

function createReadTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof ReadParameters> {
  return {
    ...vaultToolDefinition("read"),
    execute: async (_id, params) => {
      const { path, file } = getVisibleVaultFile(app, isIgnored, params.path);
      const range = {
        startLine: params.startLine,
        endLine: params.endLine,
        offset: params.offset,
        limit: params.limit,
      };
      const window = resolveLineWindow(range);
      // De-dup: a repeat read of the same range is handed a short pointer instead
      // of re-injecting the full text, so re-reading can't quietly double a file
      // into the context. Edits invalidate the path, forcing a fresh read.
      if (memo?.has({ path, offset: window.offset, limit: window.limit })) {
        return textResult(alreadyReadMessage(path), { path, deduplicated: true });
      }
      // Size guardrail: refuse a bulk dump of a very large file; guide the model
      // to paginate so one read can't blow the context window.
      const guidance = readSizeGuardrail({ path, size: file.stat?.size ?? 0, ...range });
      if (guidance) {
        return textResult(guidance, { path, tooLarge: true });
      }
      const content = await app.vault.cachedRead(file);
      const slice = sliceTextByLines(content, window);
      // Record only after a successful read — a failed/refused read (above) must
      // not poison the memo, or the next identical read would return a stale
      // "already read" pointer instead of retrying.
      memo?.mark({ path, offset: window.offset, limit: window.limit });
      return textResult(formatTextSlice(path, slice), {
        path,
        startLine: slice.startLine,
        endLine: slice.endLine,
        totalLines: slice.totalLines,
        truncated: slice.truncated,
      });
    },
  };
}

function createWriteTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof WriteParameters> {
  return {
    ...vaultToolDefinition("write"),
    execute: async (_id, params) => {
      const path = normalizeVisibleVaultPath(isIgnored, params.path);
      await ensureParentFolders(app, path);
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFolder) {
        throw new Error(`Cannot write file because a folder exists at ${path}.`);
      }
      if (existing instanceof TFile) {
        await app.vault.process(existing, () => params.content);
      } else {
        await app.vault.create(path, params.content);
      }
      memo?.invalidate(path);
      return textResult(`Wrote ${params.content.length} characters to ${path}.`, {
        path,
        bytes: params.content.length,
      });
    },
  };
}

function createEditTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof EditParameters> {
  return {
    ...vaultToolDefinition("edit"),
    execute: async (_id, params) => {
      const { path, file } = getVisibleVaultFile(app, isIgnored, params.path);
      await app.vault.process(file, (content) => applyExactEdits(content, params.edits));
      memo?.invalidate(path);
      return textResult(`Applied ${params.edits.length} edit${params.edits.length === 1 ? "" : "s"} to ${path}.`, {
        path,
        editCount: params.edits.length,
      });
    },
  };
}

function createLsTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof LsParameters> {
  return {
    ...vaultToolDefinition("ls"),
    execute: async (_id, params) => {
      const path = normalizeFolderPath(params.path ?? "");
      if (path && isIgnored(path)) throw new Error(`Folder not found: ${path}`);
      const folder = path ? app.vault.getFolderByPath(path) : app.vault.getRoot();
      if (!folder) throw new Error(`Folder not found: ${path || "/"}`);
      const rows = folder.children
        .slice()
        .filter((child) => !isIgnored(child.path))
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((child) => `${child instanceof TFolder ? "folder" : "file"}\t${child.path}`);
      return textResult(rows.length === 0 ? "(empty folder)" : truncateToolOutput(rows.join("\n")), {
        path,
        count: rows.length,
      });
    },
  };
}

function createFindTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof FindParameters> {
  return {
    ...vaultToolDefinition("find"),
    execute: async (_id, params) => {
      const maxResults = params.maxResults ?? 100;
      const matches = app.vault
        .getFiles()
        .map((file) => file.path)
        .filter((path) => !isIgnored(path))
        .filter((path) => matchesFindPattern(path, params.pattern))
        .sort((left, right) => left.localeCompare(right));
      const visible = matches.slice(0, maxResults);
      const truncated = matches.length > visible.length;
      const output = visible.length === 0 ? "No files found." : visible.join("\n");
      return textResult(truncated ? `${output}\n\n[Results truncated.]` : output, {
        pattern: params.pattern,
        count: matches.length,
        truncated,
      });
    },
  };
}

type SearchKind = "both" | "files" | "content";

function createSearchTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof SearchParameters> {
  return {
    ...vaultToolDefinition("search"),
    execute: async (_id, params) => {
      const query = params.query.trim();
      if (!query) throw new Error("search: provide a non-empty query.");

      const kind = normalizeSearchKind(params.kind);
      const rootPath = params.path ? normalizeFolderPath(params.path) : "";
      const includeFiles = kind === "both" || kind === "files";
      const includeContent = kind === "both" || kind === "content";

      const fileResults = includeFiles
        ? findVaultFiles(app, isIgnored, query, rootPath, params.maxResults ?? 100)
        : emptyFileSearch();
      const contentResults = includeContent
        ? await searchVaultContent(app, isIgnored, query, rootPath, {
            caseSensitive: params.caseSensitive,
            regex: params.regex,
            maxMatches: params.maxMatches ?? 100,
          })
        : emptyContentSearch();

      return textResult(formatSearchResults({ kind, fileResults, contentResults }), {
        query,
        kind,
        path: rootPath,
        fileCount: fileResults.count,
        fileTruncated: fileResults.truncated,
        contentCount: contentResults.matches.length,
        contentTruncated: contentResults.truncated,
      });
    },
  };
}

function createGrepTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof GrepParameters> {
  return {
    ...vaultToolDefinition("grep"),
    execute: async (_id, params) => {
      const maxMatches = params.maxMatches ?? 100;
      const rootPath = params.path ? normalizeFolderPath(params.path) : "";
      const matches: GrepMatch[] = [];
      for (const file of getSearchableFiles(app, rootPath, isIgnored)) {
        const content = await app.vault.cachedRead(file);
        matches.push(
          ...grepContent(file.path, content, params.pattern, {
            caseSensitive: params.caseSensitive,
            regex: params.regex,
            maxMatches: maxMatches - matches.length,
          }),
        );
        if (matches.length >= maxMatches) break;
      }
      return textResult(formatGrepMatches(matches, matches.length >= maxMatches), {
        pattern: params.pattern,
        count: matches.length,
        truncated: matches.length >= maxMatches,
      });
    },
  };
}

function normalizeSearchKind(kind: string | undefined): SearchKind {
  if (kind === undefined || kind === "" || kind === "both") return "both";
  if (kind === "files" || kind === "content") return kind;
  throw new Error('search: kind must be "both", "files", or "content".');
}

function findVaultFiles(
  app: App,
  isIgnored: IgnoreMatcher,
  query: string,
  rootPath: string,
  maxResults: number,
): { matches: string[]; count: number; truncated: boolean } {
  const matches = app.vault
    .getFiles()
    .map((file) => file.path)
    .filter((path) => !isIgnored(path))
    .filter((path) => !rootPath || path === rootPath || path.startsWith(`${rootPath}/`))
    .filter((path) => matchesFindPattern(path, query))
    .sort((left, right) => left.localeCompare(right));
  const visible = matches.slice(0, maxResults);
  return { matches: visible, count: matches.length, truncated: matches.length > visible.length };
}

async function searchVaultContent(
  app: App,
  isIgnored: IgnoreMatcher,
  query: string,
  rootPath: string,
  options: { caseSensitive?: boolean; regex?: boolean; maxMatches: number },
): Promise<{ matches: GrepMatch[]; truncated: boolean }> {
  const matches: GrepMatch[] = [];
  for (const file of getSearchableFiles(app, rootPath, isIgnored)) {
    const content = await app.vault.cachedRead(file);
    matches.push(
      ...grepContent(file.path, content, query, {
        caseSensitive: options.caseSensitive,
        regex: options.regex,
        maxMatches: options.maxMatches - matches.length,
      }),
    );
    if (matches.length >= options.maxMatches) break;
  }
  return { matches, truncated: matches.length >= options.maxMatches };
}

function emptyFileSearch(): { matches: string[]; count: number; truncated: boolean } {
  return { matches: [], count: 0, truncated: false };
}

function emptyContentSearch(): { matches: GrepMatch[]; truncated: boolean } {
  return { matches: [], truncated: false };
}

function formatSearchResults(options: {
  kind: SearchKind;
  fileResults: { matches: string[]; count: number; truncated: boolean };
  contentResults: { matches: GrepMatch[]; truncated: boolean };
}): string {
  const sections: string[] = [];
  if (options.kind === "both" || options.kind === "files") {
    const fileText = options.fileResults.matches.length === 0
      ? "No file name matches."
      : options.fileResults.matches.join("\n");
    sections.push(
      [
        `File name matches (${options.fileResults.count}):`,
        options.fileResults.truncated ? `${fileText}\n\n[File results truncated.]` : fileText,
      ].join("\n"),
    );
  }
  if (options.kind === "both" || options.kind === "content") {
    sections.push(
      [
        `Content matches (${options.contentResults.matches.length}):`,
        formatGrepMatches(options.contentResults.matches, options.contentResults.truncated),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

function createActiveNoteTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof ActiveNoteParameters> {
  return {
    ...vaultToolDefinition("get_active_note"),
    execute: async (_id, params) => {
      const view = app.workspace.getActiveViewOfType(MarkdownView);
      const activeFile = app.workspace.getActiveFile();
      const file = view?.file ?? activeFile;
      // An ignored active note is treated as if no note were open at all.
      if (!file || file.extension !== "md" || isIgnored(file.path)) throw new Error("No active Markdown note.");
      const lines = [`Active note: ${file.path}`];
      const selection =
        params.includeSelection && view?.file?.path === file.path
          ? view.editor.getSelection()
          : "";
      if (params.includeSelection) lines.push("", "Selection:", selection || "(no selection)");
      if (params.includeContent) {
        const content = await app.vault.cachedRead(file);
        lines.push("", "Content:", formatTextSlice(file.path, sliceTextByLines(content, { limit: 200 })));
      }
      return textResult(lines.join("\n"), { path: file.path, hasSelection: selection.length > 0 });
    },
  };
}

function createRenameTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof RenameParameters> {
  return {
    ...vaultToolDefinition("rename"),
    execute: async (_id, params) => {
      const { path, file } = getVisibleVaultFile(app, isIgnored, params.path);
      const newPath = normalizeVisibleVaultPath(isIgnored, params.newPath);
      // Block both the source (invisible) and the destination (no smuggling into an ignored zone).
      if (app.vault.getAbstractFileByPath(newPath)) {
        throw new Error(`Something already exists at ${newPath}.`);
      }
      await ensureParentFolders(app, newPath);
      await app.fileManager.renameFile(file, newPath);
      memo?.invalidate(path);
      memo?.invalidate(newPath);
      return textResult(`Renamed ${path} to ${newPath}.`, { path, newPath });
    },
  };
}

function createDeleteTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof DeleteParameters> {
  return {
    ...vaultToolDefinition("delete"),
    execute: async (_id, params) => {
      const { path, entry } = getVisibleVaultEntry(app, isIgnored, params.path);
      if (entry instanceof TFolder && entry.children.length > 0) {
        throw new Error(`Folder not empty: ${path}`);
      }
      await app.fileManager.trashFile(entry);
      memo?.invalidate(path);
      return textResult(`Moved ${path} to trash.`, { path, kind: entry instanceof TFolder ? "folder" : "file" });
    },
  };
}

function createBacklinksTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof BacklinksParameters> {
  return {
    ...vaultToolDefinition("get_backlinks"),
    execute: async (_id, params) => {
      const { path, file } = getVisibleVaultFile(app, isIgnored, params.path);
      const sources = getBacklinkSources(app, file).filter((entry) => !isIgnored(entry.path));
      const lines = sources.map((entry) => `${entry.path}\t${entry.count} ref${entry.count === 1 ? "" : "s"}`);
      return textResult(lines.length === 0 ? "No backlinks." : truncateToolOutput(lines.join("\n")), {
        path,
        count: sources.length,
        sources: sources.map((entry) => entry.path),
      });
    },
  };
}

function createLinksTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof LinksParameters> {
  return {
    ...vaultToolDefinition("get_links"),
    execute: async (_id, params) => {
      const { path, file } = getVisibleVaultFile(app, isIgnored, params.path);
      const targets = getOutboundLinks(app, file.path).filter((entry) => !isIgnored(entry.path));
      const lines = targets.map((entry) => `${entry.path}\t${entry.count} link${entry.count === 1 ? "" : "s"}`);
      return textResult(lines.length === 0 ? "No outbound links." : truncateToolOutput(lines.join("\n")), {
        path,
        count: targets.length,
        targets: targets.map((entry) => entry.path),
      });
    },
  };
}

function createLocalGraphTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof LocalGraphParameters> {
  return {
    ...vaultToolDefinition("local_graph"),
    execute: async (_id, params) => {
      const { path, file } = getVisibleVaultFile(app, isIgnored, params.path);
      const inbound = getBacklinkSources(app, file).filter((entry) => !isIgnored(entry.path));
      const outbound = getOutboundLinks(app, file.path).filter((entry) => !isIgnored(entry.path));
      const inboundLines = inbound.length === 0 ? ["  (none)"] : inbound.map((entry) => `  ${entry.path}`);
      const outboundLines = outbound.length === 0 ? ["  (none)"] : outbound.map((entry) => `  ${entry.path}`);
      const text = [`Inbound (${inbound.length}):`, ...inboundLines, `Outbound (${outbound.length}):`, ...outboundLines].join("\n");
      return textResult(truncateToolOutput(text), {
        path,
        inbound: inbound.map((entry) => entry.path),
        outbound: outbound.map((entry) => entry.path),
      });
    },
  };
}

function createGetPropertiesTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof GetPropertiesParameters> {
  return {
    ...vaultToolDefinition("get_properties"),
    execute: async (_id, params) => {
      const { path, file } = getVisibleVaultFile(app, isIgnored, params.path);
      const frontmatter = await readFrontmatter(app, file);
      const keys = Object.keys(frontmatter);
      const text = keys.length === 0 ? "(no frontmatter properties)" : JSON.stringify(frontmatter, null, 2);
      return textResult(truncateToolOutput(text), { path, keys });
    },
  };
}

function createSetPropertiesTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof SetPropertiesParameters> {
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
    const { position, ...rest } = cached as Record<string, unknown>;
    void position;
    return rest;
  }
  const content = await app.vault.cachedRead(file);
  return parseFrontmatterBlock(content);
}

/** Parse the leading `---` YAML block of a note into structured data. */
function parseFrontmatterBlock(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  // parseYaml returns null/undefined for an empty or scalar block; normalize to {}.
  const parsed = parseYaml(match[1]) as Record<string, unknown> | null | undefined;
  return parsed && typeof parsed === "object" ? parsed : {};
}

function getVaultFile(app: App, path: string): TFile {
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error(`File not found: ${path}`);
  return file;
}

function normalizeVisibleVaultPath(isIgnored: IgnoreMatcher, path: string): string {
  const normalized = normalizeVaultPath(path);
  assertVisible(isIgnored, normalized);
  return normalized;
}

function getVisibleVaultFile(app: App, isIgnored: IgnoreMatcher, path: string): { path: string; file: TFile } {
  const normalized = normalizeVisibleVaultPath(isIgnored, path);
  return { path: normalized, file: getVaultFile(app, normalized) };
}

function getVisibleVaultEntry(app: App, isIgnored: IgnoreMatcher, path: string): { path: string; entry: TFile | TFolder } {
  const normalized = normalizeVisibleVaultPath(isIgnored, path);
  const entry = app.vault.getAbstractFileByPath(normalized);
  if (entry instanceof TFile || entry instanceof TFolder) return { path: normalized, entry };
  throw new Error(`File or folder not found: ${normalized}`);
}

/**
 * Reject access to an ignored path with the same error a missing file produces,
 * so the model cannot distinguish "hidden" from "does not exist".
 */
function assertVisible(isIgnored: IgnoreMatcher, path: string): void {
  if (isIgnored(path)) throw new Error(`File not found: ${path}`);
}

async function ensureParentFolders(app: App, path: string): Promise<void> {
  const parentPath = getParentPath(path);
  if (!parentPath) return;
  let currentPath = "";
  for (const segment of parentPath.split("/")) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    if (!app.vault.getFolderByPath(currentPath)) {
      await app.vault.createFolder(currentPath);
    }
  }
}

function getSearchableFiles(app: App, rootPath: string, isIgnored: IgnoreMatcher): TFile[] {
  return app.vault
    .getFiles()
    .filter((file) => TEXT_EXTENSIONS.has(file.extension.toLowerCase()))
    .filter((file) => !isIgnored(file.path))
    .filter((file) => !rootPath || file.path === rootPath || file.path.startsWith(`${rootPath}/`))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: truncateToolOutput(text) }], details };
}
