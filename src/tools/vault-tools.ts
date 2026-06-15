import { type App, TFile, TFolder, MarkdownView } from "obsidian";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { applyExactEdits } from "../vault/edit";
import { getParentPath, normalizeFolderPath, normalizeVaultPath } from "../vault/path";
import type { IgnoreMatcher } from "../vault/ignore";
import { formatGrepMatches, grepContent, matchesFindPattern, type GrepMatch } from "../vault/search";
import { formatTextSlice, sliceTextByLines, truncateToolOutput } from "../vault/truncate";

/** Tools that change the vault. Used to pick a default approval policy. */
export const MUTATING_TOOLS = new Set(["write", "edit", "delete", "rename"]);

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

/**
 * All built-in vault tools, bound to the active Obsidian app.
 *
 * `isIgnored` makes paths invisible to the agent: ignored files cannot be read,
 * listed, searched, or mutated, and report as "not found" so the model cannot
 * even infer their existence. Defaults to a permit-all matcher.
 */
export function createVaultTools(app: App, isIgnored: IgnoreMatcher = () => false): AgentTool[] {
  return [
    createReadTool(app, isIgnored),
    createWriteTool(app, isIgnored),
    createEditTool(app, isIgnored),
    createLsTool(app, isIgnored),
    createFindTool(app, isIgnored),
    createGrepTool(app, isIgnored),
    createActiveNoteTool(app, isIgnored),
    createRenameTool(app, isIgnored),
    createDeleteTool(app, isIgnored),
    createBacklinksTool(app, isIgnored),
    createLinksTool(app, isIgnored),
    createLocalGraphTool(app, isIgnored),
  ];
}

function createReadTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof ReadParameters> {
  return {
    name: "read",
    label: "Read file",
    description: "Read a vault-relative Markdown/text file. Use offset and limit for large files.",
    parameters: ReadParameters,
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      assertVisible(isIgnored, path);
      const file = getVaultFile(app, path);
      const content = await app.vault.cachedRead(file);
      const slice = sliceTextByLines(content, { offset: params.offset, limit: params.limit });
      return textResult(formatTextSlice(path, slice), { path, totalLines: slice.totalLines, truncated: slice.truncated });
    },
  };
}

function createWriteTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof WriteParameters> {
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
        await app.vault.modify(existing, params.content);
      } else {
        await app.vault.create(path, params.content);
      }
      return textResult(`Wrote ${params.content.length} characters to ${path}.`, {
        path,
        bytes: params.content.length,
      });
    },
  };
}

function createEditTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof EditParameters> {
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
      const content = await app.vault.read(file);
      const updated = applyExactEdits(content, params.edits);
      await app.vault.modify(file, updated);
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

function createRenameTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof RenameParameters> {
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
      return textResult(`Renamed ${path} to ${newPath}.`, { path, newPath });
    },
  };
}

function createDeleteTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof DeleteParameters> {
  return {
    name: "delete",
    label: "Delete file",
    description: "Move a vault file to trash (recoverable). Respects the user's deleted-files setting.",
    parameters: DeleteParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const path = normalizeVaultPath(params.path);
      assertVisible(isIgnored, path);
      const file = getVaultFile(app, path);
      await app.fileManager.trashFile(file);
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
