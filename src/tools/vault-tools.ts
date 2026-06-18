import { type App, TFile, TFolder, MarkdownView, parseYaml } from "obsidian";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { applyExactEdits } from "../vault/edit";
import { getParentPath, normalizeFolderPath, normalizeVaultPath } from "../vault/path";
import type { IgnoreMatcher } from "../vault/ignore";
import { formatGrepMatches, grepContent, matchesFindPattern, type GrepMatch } from "../vault/search";
import { alreadyReadMessage, type ReadMemo } from "../vault/read-memo";
import { formatTextSlice, readSizeGuardrail, sliceTextByLines, truncateToolOutput } from "../vault/truncate";

/** Tools that change the vault. Used to pick a default approval policy. */
export const MUTATING_TOOLS = new Set(["write", "edit", "delete", "rename", "set_properties"]);

const TEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "jsonl", "csv", "tsv", "yaml", "yml",
  "css", "js", "ts", "tsx", "jsx", "html", "xml",
]);

const ReadParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path to the file, including extension" }),
  offset: Type.Optional(Type.Number({ description: "1-based line to start reading from" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const WriteParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path, e.g. Folder/Note.md" }),
  content: Type.String({ description: "Full file content to write" }),
});

const EditParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path to the file to edit" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "Exact text to replace (must occur exactly once)" }),
      newText: Type.String({ description: "Replacement text" }),
    }),
    { description: "One or more exact replacements applied in a single pass" },
  ),
});

const LsParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Vault-relative folder path; empty for the vault root" })),
});

const FindParameters = Type.Object({
  pattern: Type.String({ description: "Case-insensitive substring or simple * and ? glob" }),
  maxResults: Type.Optional(Type.Number()),
});

const GrepParameters = Type.Object({
  pattern: Type.String({ description: "Text or regex to search for in file contents" }),
  path: Type.Optional(Type.String({ description: "Restrict search to this vault-relative folder" })),
  caseSensitive: Type.Optional(Type.Boolean()),
  regex: Type.Optional(Type.Boolean({ description: "Treat pattern as a regular expression" })),
  maxMatches: Type.Optional(Type.Number()),
});

const ActiveNoteParameters = Type.Object({
  includeContent: Type.Optional(Type.Boolean({ description: "Include the note's text" })),
  includeSelection: Type.Optional(Type.Boolean({ description: "Include the current editor selection" })),
});

const RenameParameters = Type.Object({
  path: Type.String({ description: "Current vault-relative path" }),
  newPath: Type.String({ description: "New vault-relative path; backlinks are updated automatically" }),
});

const DeleteParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path to move to trash" }),
});

const BacklinksParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path of the note to find inbound links to" }),
});

const LinksParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path of the note whose outbound links to list" }),
});

const LocalGraphParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path of the note to map the neighborhood of" }),
});

const GetPropertiesParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path of the note whose frontmatter to read" }),
});

const SetPropertiesParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path of the note whose frontmatter to update" }),
  properties: Type.Record(Type.String(), Type.Unknown(), {
    description:
      "Key/value pairs to merge into the note's YAML frontmatter. Existing keys are overwritten; " +
      "keys not listed are left untouched. Pass null as a value to delete that key.",
  }),
});

/**
 * All built-in vault tools, bound to the active Obsidian app.
 *
 * `isIgnored` makes paths invisible to the agent: ignored files cannot be read,
 * listed, searched, or mutated, and report as "not found" so the model cannot
 * even infer their existence. Defaults to a permit-all matcher.
 */
export function createVaultTools(app: App, isIgnored: IgnoreMatcher = () => false, memo?: ReadMemo): AgentTool[] {
  return [
    createReadTool(app, isIgnored, memo),
    createWriteTool(app, isIgnored, memo),
    createEditTool(app, isIgnored, memo),
    createLsTool(app, isIgnored),
    createFindTool(app, isIgnored),
    createGrepTool(app, isIgnored),
    createActiveNoteTool(app, isIgnored),
    createRenameTool(app, isIgnored, memo),
    createDeleteTool(app, isIgnored, memo),
    createBacklinksTool(app, isIgnored),
    createLinksTool(app, isIgnored),
    createLocalGraphTool(app, isIgnored),
    createGetPropertiesTool(app, isIgnored),
    createSetPropertiesTool(app, isIgnored),
  ];
}

function createReadTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof ReadParameters> {
  return {
    name: "read",
    label: "Read file",
    description: "Read a vault-relative Markdown/text file. Use offset and limit for large files.",
    parameters: ReadParameters,
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      assertVisible(isIgnored, path);
      // De-dup: a repeat read of the same range is handed a short pointer instead
      // of re-injecting the full text, so re-reading can't quietly double a file
      // into the context. Edits invalidate the path, forcing a fresh read.
      if (memo?.has({ path, offset: params.offset, limit: params.limit })) {
        return textResult(alreadyReadMessage(path), { path, deduplicated: true });
      }
      const file = getVaultFile(app, path);
      // Size guardrail: refuse a bulk dump of a very large file; guide the model
      // to paginate so one read can't blow the context window.
      const guidance = readSizeGuardrail({ path, size: file.stat?.size ?? 0, offset: params.offset, limit: params.limit });
      if (guidance) {
        return textResult(guidance, { path, tooLarge: true });
      }
      const content = await app.vault.cachedRead(file);
      const slice = sliceTextByLines(content, { offset: params.offset, limit: params.limit });
      // Record only after a successful read — a failed/refused read (above) must
      // not poison the memo, or the next identical read would return a stale
      // "already read" pointer instead of retrying.
      memo?.mark({ path, offset: params.offset, limit: params.limit });
      return textResult(formatTextSlice(path, slice), { path, totalLines: slice.totalLines, truncated: slice.truncated });
    },
  };
}

function createWriteTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof WriteParameters> {
  return {
    name: "write",
    label: "Write file",
    description: "Create or overwrite a vault-relative file. Parent folders are created as needed.",
    parameters: WriteParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      assertVisible(isIgnored, path);
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
    name: "edit",
    label: "Edit file",
    description:
      "Apply exact text replacements to a vault-relative file. Each oldText must match exactly once.",
    parameters: EditParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      assertVisible(isIgnored, path);
      const file = getVaultFile(app, path);
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
    name: "ls",
    label: "List folder",
    description: "List files and folders at a vault-relative folder path.",
    parameters: LsParameters,
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
    name: "find",
    label: "Find files",
    description: "Find vault files by case-insensitive substring or simple * and ? glob pattern.",
    parameters: FindParameters,
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

function createGrepTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof GrepParameters> {
  return {
    name: "grep",
    label: "Search file text",
    description: "Search text files in the vault. Literal by default; set regex true for regular expressions.",
    parameters: GrepParameters,
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

function createActiveNoteTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof ActiveNoteParameters> {
  return {
    name: "get_active_note",
    label: "Get active note",
    description:
      "Return the active note path, with optional selected text and content. Use when the user says 'this note'.",
    parameters: ActiveNoteParameters,
    execute: async (_id, params) => {
      const view = app.workspace.getActiveViewOfType(MarkdownView);
      const file = view?.file;
      // An ignored active note is treated as if no note were open at all.
      if (!view || !file || isIgnored(file.path)) throw new Error("No active Markdown note.");
      const lines = [`Active note: ${file.path}`];
      const selection = params.includeSelection ? view.editor.getSelection() : "";
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
    name: "rename",
    label: "Rename or move file",
    description: "Rename or move a vault file. Wikilinks and backlinks are updated automatically.",
    parameters: RenameParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      const newPath = normalizeVaultPath(params.newPath);
      // Block both the source (invisible) and the destination (no smuggling into an ignored zone).
      assertVisible(isIgnored, path);
      assertVisible(isIgnored, newPath);
      const file = getVaultFile(app, path);
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
    name: "delete",
    label: "Delete file",
    description: "Move a vault file to trash (recoverable).",
    parameters: DeleteParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      assertVisible(isIgnored, path);
      const file = getVaultFile(app, path);
      await app.vault.trash(file, true);
      memo?.invalidate(path);
      return textResult(`Moved ${path} to trash.`, { path });
    },
  };
}

function createBacklinksTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof BacklinksParameters> {
  return {
    name: "get_backlinks",
    label: "Get backlinks",
    description: "List notes that link TO a given note (inbound wikilinks).",
    parameters: BacklinksParameters,
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      assertVisible(isIgnored, path);
      const file = getVaultFile(app, path);
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
    name: "get_links",
    label: "Get outbound links",
    description: "List the notes a given note links TO (outbound resolved links).",
    parameters: LinksParameters,
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      assertVisible(isIgnored, path);
      const file = getVaultFile(app, path);
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
    name: "local_graph",
    label: "Local graph",
    description:
      "Show a note's immediate neighborhood: inbound (backlinks) and outbound (resolved links) notes.",
    parameters: LocalGraphParameters,
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      assertVisible(isIgnored, path);
      const file = getVaultFile(app, path);
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
    name: "get_properties",
    label: "Get note properties",
    description: "Read a note's YAML frontmatter as structured key/value data.",
    parameters: GetPropertiesParameters,
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      assertVisible(isIgnored, path);
      const file = getVaultFile(app, path);
      const frontmatter = await readFrontmatter(app, file);
      const keys = Object.keys(frontmatter);
      const text = keys.length === 0 ? "(no frontmatter properties)" : JSON.stringify(frontmatter, null, 2);
      return textResult(truncateToolOutput(text), { path, keys });
    },
  };
}

function createSetPropertiesTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof SetPropertiesParameters> {
  return {
    name: "set_properties",
    label: "Set note properties",
    description:
      "Merge keys into a note's YAML frontmatter (set/overwrite; pass null to delete a key). " +
      "Edits the structured frontmatter, never the raw YAML text.",
    parameters: SetPropertiesParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      assertVisible(isIgnored, path);
      const file = getVaultFile(app, path);
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
