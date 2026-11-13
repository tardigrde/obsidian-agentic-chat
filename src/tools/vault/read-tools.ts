import { type App, TFolder, MarkdownView } from "obsidian";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { IgnoreMatcher } from "../../vault/ignore";
import { normalizeFolderPath } from "../../vault/path";
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
import type { BuiltinToolName } from "../tool-contracts";
import {
  ActiveNoteParameters,
  LsParameters,
  ReadParameters,
  VaultInspectParameters,
  vaultToolDefinition,
} from "../vault-tool-definitions";
import { createGetPropertiesTool, createLocalGraphTool } from "./graph-tools";
import { createSearchTool } from "./search-tools";
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
  const result = await tool.execute(id, params, signal);
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

export function createReadTool(app: App, isIgnored: IgnoreMatcher, memo?: ReadMemo): AgentTool<typeof ReadParameters> {
  return {
    ...vaultToolDefinition("read"),
    execute: async (_id, params) => {
      const path = normalizeVisibleVaultPath(isIgnored, params.path);
      // A folder path is a common guess; give an actionable error instead of a
      // misleading "File not found" so the model lists the folder and moves on.
      const entry = app.vault.getAbstractFileByPath(path);
      if (entry instanceof TFolder) {
        throw new Error(`${path} is a folder — use ls to list its contents.`);
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
      let content: string;
      try {
        content = await app.vault.adapter.read(path);
      } catch (readError) {
        try {
          await app.vault.adapter.list(path);
        } catch (listError) {
          throw new Error(`File not found: ${path}`, { cause: listError });
        }
        throw new Error(`${path} is a folder — use ls to list its contents.`, { cause: readError });
      }
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

export function createLsTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof LsParameters> {
  return {
    ...vaultToolDefinition("ls"),
    execute: async (_id, params) => {
      const path = normalizeFolderPath(params.path ?? "");
      if (path && isIgnored(path)) throw new Error(`Folder not found: ${path}`);
      const folder = path ? app.vault.getFolderByPath(path) : app.vault.getRoot();
      if (folder) {
        const rows = folder.children
          .slice()
          .filter((child) => !isIgnored(child.path))
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((child) => `${child instanceof TFolder ? "folder" : "file"}\t${child.path}`);
        return textResult(rows.length === 0 ? "(empty folder)" : truncateToolOutput(rows.join("\n")), {
          path,
          count: rows.length,
        });
      }
      // Stale tree: dot-folders (e.g. .agentic-plugins) created outside the
      // session are on disk but missing from the vault index — fall back to
      // the adapter like the plugin loader does. A missing path still throws
      // below, so "not found" keeps meaning "nowhere", not "stale".
      try {
        const listing = await app.vault.adapter.list(path);
        // Sort by path like the tree branch (which sorts child.path), not by
        // rendered row — "file\t" sorts before "folder\t" and would regroup.
        const entries = [
          ...(listing?.folders ?? []).map((entry) => ({ kind: "folder", path: trimSlashes(entry) })),
          ...(listing?.files ?? []).map((entry) => ({ kind: "file", path: trimSlashes(entry) })),
        ]
          .filter((entry) => entry.path && !isIgnored(entry.path))
          .sort((left, right) => left.path.localeCompare(right.path));
        const rows = entries.map((entry) => `${entry.kind}\t${entry.path}`);
        return textResult(rows.length === 0 ? "(empty folder)" : truncateToolOutput(rows.join("\n")), {
          path,
          count: rows.length,
        });
      } catch {
        throw new Error(`Folder not found: ${path || "/"}`);
      }
    },
  };
}

export function createActiveNoteTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof ActiveNoteParameters> {
  return {
    ...vaultToolDefinition("get_active_note"),
    execute: async (_id, params) => {
      const view = app.workspace.getActiveViewOfType(MarkdownView);
      const activeFile = app.workspace.getActiveFile();
      const file = view?.file ?? activeFile;
      // An ignored active note is treated as if no note were open at all.
      if (file?.extension !== "md" || isIgnored(file.path)) throw new Error("No active Markdown note.");
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
      // When content is included, file body is untrusted vault data
      const useUntrusted = !!params.includeContent;
      return useUntrusted
        ? untrustedTextResult(lines.join("\n"), { path: file.path, hasSelection: selection.length > 0 }, "get_active_note")
        : textResult(lines.join("\n"), { path: file.path, hasSelection: selection.length > 0 });
    },
  };
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
