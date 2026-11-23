import { privatePathMessage } from "../../vault/private-rules";
import { selectionForPath } from "../../vault/editor-for-path";
import { type App, TFolder, MarkdownView } from "obsidian";
import { binaryKindByExtension, binaryReadError, looksBinary } from "../../vault/binary-file";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { IgnoreMatcher } from "../../vault/ignore";
import { normalizeFolderPath } from "../../vault/path";
import { findVaultEntry, pathSuggestion } from "../../vault/path-lookup";
import {
  alreadyReadMessage,
  cachedReadMessage,
  coveredReadMessage,
  type ReadMemo,
  type RequestedWindow,
} from "../../vault/read-memo";
import {
  formatTextSlice,
  readSizeGuardrail,
  resolveLineWindow,
  sliceTextByLines,
  truncateToolOutput,
  type LineWindow,
} from "../../vault/truncate";
import {
  ReadParameters,
  VaultInspectParameters,
  vaultToolDefinition,
} from "../vault-tool-definitions";
import { inspectLocalGraph, inspectProperties } from "./graph-tools";
import { searchVault } from "./search-tools";
import {
  normalizeVisibleVaultPath,
  textResult,
  trimSlashes,
  untrustedTextResult,
} from "./shared";

type VaultInspectAction = "list" | "search" | "active_note" | "local_graph" | "properties";

export function createVaultInspectTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof VaultInspectParameters> {
  return {
    ...vaultToolDefinition("vault_inspect"),
    execute: async (_id, params) => {
      const action = normalizeVaultInspectAction(params.action);
      const result = await runInspectAction(app, isIgnored, action, params);
      return { ...result, details: { inspectAction: action, ...(result.details ?? {}) } };
    },
  };
}

type VaultInspectParams = Parameters<AgentTool<typeof VaultInspectParameters>["execute"]>[1];
type ToolResult = AgentToolResult<Record<string, unknown>>;

function runInspectAction(
  app: App,
  isIgnored: IgnoreMatcher,
  action: VaultInspectAction,
  params: VaultInspectParams,
): Promise<ToolResult> {
  switch (action) {
    case "list":
      return listFolder(app, isIgnored, params.path);
    case "search":
      return searchVault(app, isIgnored, {
        query: requiredString(params.query, "query"),
        kind: params.kind,
        path: params.path,
        caseSensitive: params.caseSensitive,
        regex: params.regex,
        maxResults: params.maxResults,
        maxMatches: params.maxMatches,
      });
    case "active_note":
      return inspectActiveNote(app, isIgnored, {
        includeContent: params.includeContent,
        includeSelection: params.includeSelection,
      });
    case "local_graph":
      return inspectLocalGraph(app, isIgnored, requiredString(params.path, "path"));
    case "properties":
      return inspectProperties(app, isIgnored, requiredString(params.path, "path"));
  }
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

export function createReadTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof ReadParameters> {
  return {
    ...vaultToolDefinition("read"),
    execute: async (_id, params) => {
      const path = normalizeVisibleVaultPath(isIgnored, params.path);
      // A folder path is a common guess; give an actionable error instead of a
      // misleading "File not found" so the model lists the folder and moves on.
      const entry = app.vault.getAbstractFileByPath(path);
      if (entry instanceof TFolder) {
        throw new Error(`${path} is a folder — use vault_inspect with action "list" to list its contents.`);
      }
      const file = app.vault.getFileByPath(path);
      const range = {
        startLine: params.startLine,
        endLine: params.endLine,
        offset: params.offset,
        limit: params.limit,
      };
      const window = resolveLineWindow(range);
      const readKey = { path, offset: window.offset, limit: window.limit };
      const binaryKind = binaryKindByExtension(path);
      if (file && binaryKind) throw binaryReadError(path, binaryKind, file.stat?.size);
      if (file) {
        const mtime = file.stat?.mtime ?? 0;
        // De-dup: a repeat read of the same range in the same turn is handed a
        // short pointer so the prompt can't quietly double a file.
        if (memo?.has(readKey)) {
          return textResult(alreadyReadMessage(path), { path, deduplicated: true });
        }

        // Harness-side cache: when the file has not changed since the last read
        // of this range, serve the stored slice with zero I/O cost.
        const cached = memo?.getCached(readKey, mtime);
        if (cached) {
          memo?.mark(readKey);
          return untrustedTextResult(cachedReadMessage(path, cached.timestamp) + cached.content, {
            path,
            cached: true,
            timestamp: cached.timestamp,
          }, "read");
        }

        // Redundant-range guard: the requested lines were already served this
        // session (exactly or inside a wider range) and the file is unchanged, so
        // hand the model a pointer plus the prior content instead of re-pulling.
        const covered = memo?.coverageFor(requestedWindow(path, window), mtime);
        if (covered) {
          return untrustedTextResult(coveredReadMessage(path, covered), { path, deduplicated: true, covered: true }, "read");
        }

        // Size guardrail: refuse a bulk dump of a very large file; guide the model
        // to paginate so one read can't blow the context window.
        const guidance = readSizeGuardrail({ path, size: file.stat?.size ?? 0, ...range });
        if (guidance) {
          return textResult(guidance, { path, tooLarge: true });
        }
        const content = await app.vault.cachedRead(file);
        if (looksBinary(content)) throw binaryReadError(path, null, file.stat?.size);
        return finishRead(path, content, window, readKey, mtime, memo);
      }
      // Stale tree: the file is on disk (e.g. under a dot-folder the vault
      // index has not picked up) but missing from getFileByPath — fall back
      // to the adapter like the plugin loader does. A path that is a folder
      // on disk still reports as a folder so the model lists it and moves on.
      // De-dup first so a repeat read never pays the adapter cost twice.
      if (memo?.has(readKey)) {
        return textResult(alreadyReadMessage(path), { path, deduplicated: true });
      }
      // A known binary off the index is refused before its bytes are read.
      if (binaryKind && (await app.vault.adapter.exists(path))) throw binaryReadError(path, binaryKind, undefined);
      let content: string;
      try {
        content = await app.vault.adapter.read(path);
      } catch (readError) {
        try {
          await app.vault.adapter.list(path);
        } catch (listError) {
          throw new Error(`File not found: ${path}`, { cause: listError });
        }
        throw new Error(`${path} is a folder — use vault_inspect with action "list" to list its contents.`, { cause: readError });
      }
      if (looksBinary(content)) throw binaryReadError(path, null, undefined);
      const guidance = readSizeGuardrail({ path, size: content.length, ...range });
      if (guidance) {
        return textResult(guidance, { path, tooLarge: true });
      }
      // No mtime is available off-tree; skip the mtime-keyed cache/coverage so
      // a later indexed read cannot be poisoned by this fallback slice.
      const slice = sliceTextByLines(content, window);
      memo?.mark(readKey);
      return untrustedTextResult(formatTextSlice(path, slice), {
        path,
        startLine: slice.startLine,
        endLine: slice.endLine,
        totalLines: slice.totalLines,
        truncated: slice.truncated,
      }, "read");
    },
  };
}

function finishRead(
  path: string,
  content: string,
  window: LineWindow,
  readKey: { path: string; offset: number | undefined; limit: number | undefined },
  mtime: number,
  memo?: ReadMemo,
): AgentToolResult<Record<string, unknown>> {
  const slice = sliceTextByLines(content, window);
  // Record only after a successful read — a failed/refused read must
  // not poison the memo, or the next identical read would return a stale
  // "already read" pointer instead of retrying.
  memo?.mark(readKey);
  memo?.cache(readKey, mtime, formatTextSlice(path, slice));
  memo?.recordCoverage(
    { path, startLine: slice.startLine, endLine: slice.endLine, content: slice.text },
    mtime,
    slice.startLine === 1 && slice.endLine === slice.totalLines && !slice.truncated,
  );
  return untrustedTextResult(formatTextSlice(path, slice), {
    path,
    startLine: slice.startLine,
    endLine: slice.endLine,
    totalLines: slice.totalLines,
    truncated: slice.truncated,
  }, "read");
}

/**
 * A folder listing that says how many private children it hides (U4 #11): a
 * folder whose children are all private must not read "(empty folder)", or
 * the model reports "confirmed empty".
 */
function listingResult(rows: string[], hidden: number, path: string): ToolResult {
  const note = hidden > 0 ? `${hidden} private ${hidden === 1 ? "item" : "items"} hidden (excluded in the Ignored paths setting).` : "";
  const body = rows.length === 0 ? (note ? note : "(empty folder)") : truncateToolOutput(note ? `${rows.join("\n")}\n${note}` : rows.join("\n"));
  return textResult(body, { path, count: rows.length, ...(hidden > 0 ? { hidden } : {}) });
}

/** List a vault folder (`vault_inspect` action `list`). Ignored children stay hidden. */
export async function listFolder(app: App, isIgnored: IgnoreMatcher, folder: string | undefined): Promise<ToolResult> {
  const path = normalizeFolderPath(folder ?? "");
  if (path && isIgnored(path)) throw new Error(privatePathMessage(path, isIgnored));
  const entry = path ? findVaultEntry(app, path) : app.vault.getRoot();
  if (entry instanceof TFolder) {
    const visible = entry.children.filter((child) => !isIgnored(child.path));
    const rows = visible
      .slice()
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((child) => `${child instanceof TFolder ? "folder" : "file"}\t${child.path}`);
    return listingResult(rows, entry.children.length - visible.length, path);
  }
  // Stale tree: dot-folders (e.g. .agentic-plugins) created outside the
  // session are on disk but missing from the vault index — fall back to
  // the adapter like the plugin loader does. A missing path still throws
  // below, so "not found" keeps meaning "nowhere", not "stale".
  try {
    const listing = await app.vault.adapter.list(path);
    // Sort by path like the tree branch (which sorts child.path), not by
    // rendered row — "file\t" sorts before "folder\t" and would regroup.
    const all = [
      ...(listing?.folders ?? []).map((entry) => ({ kind: "folder", path: trimSlashes(entry) })),
      ...(listing?.files ?? []).map((entry) => ({ kind: "file", path: trimSlashes(entry) })),
    ].filter((entry) => entry.path);
    const entries = all
      .filter((entry) => !isIgnored(entry.path))
      .sort((left, right) => left.path.localeCompare(right.path));
    const rows = entries.map((entry) => `${entry.kind}\t${entry.path}`);
    return listingResult(rows, all.length - entries.length, path);
  } catch {
    throw new Error(folderNotFoundMessage(app, path, isIgnored));
  }
}

function folderNotFoundMessage(app: App, path: string, isIgnored: IgnoreMatcher): string {
  const base = `Folder not found: ${path || "/"}`;
  const suggestion = pathSuggestion(app, path, isIgnored);
  return suggestion ? `${base}\nDid you mean "${suggestion}"?` : base;
}

/** Describe the active note (`vault_inspect` action `active_note`). */
async function inspectActiveNote(
  app: App,
  isIgnored: IgnoreMatcher,
  params: { includeContent?: boolean; includeSelection?: boolean },
): Promise<ToolResult> {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const activeFile = app.workspace.getActiveFile();
  const file = view?.file ?? activeFile;
  // An ignored active note is treated as if no note were open at all.
  if (file?.extension !== "md" || isIgnored(file.path)) throw new Error("No active Markdown note.");
  const lines = [`Active note: ${file.path}`];
  const selection = params.includeSelection ? selectionForPath(app, file.path) : "";
  if (params.includeSelection) lines.push("", "Selection:", selection || "(no selection)");
  if (params.includeContent) {
    const content = await app.vault.cachedRead(file);
    lines.push("", "Content:", formatTextSlice(file.path, sliceTextByLines(content, { limit: 200 })));
  }
  // When content is included, file body is untrusted vault data
  const useUntrusted = !!params.includeContent;
  return useUntrusted
    ? untrustedTextResult(lines.join("\n"), { path: file.path, hasSelection: selection.length > 0 }, "vault_inspect")
    : textResult(lines.join("\n"), { path: file.path, hasSelection: selection.length > 0 });
}

/**
 * Express a resolved line window as the 1-based window the coverage guard tracks.
 * A window with no limit runs to the end of the file, which only a previous
 * full read can satisfy.
 */
function requestedWindow(path: string, window: LineWindow): RequestedWindow {
  const start = Math.max(1, window.offset ?? 1);
  if (window.limit === undefined) return { path, start, end: Number.POSITIVE_INFINITY, toEnd: true };
  return { path, start, end: start + Math.max(0, window.limit) - 1, toEnd: false };
}
