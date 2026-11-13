import type { App, TFile } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { IgnoreMatcher } from "../../vault/ignore";
import { normalizeFolderPath } from "../../vault/path";
import { formatGrepMatches, grepContent, matchesFindPattern, type GrepMatch } from "../../vault/search";
import {
  FindParameters,
  GrepParameters,
  SearchParameters,
  vaultToolDefinition,
} from "../vault-tool-definitions";
import { TEXT_EXTENSIONS, textResult, untrustedTextResult } from "./shared";

export function createFindTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof FindParameters> {
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

export function createSearchTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof SearchParameters> {
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

      return untrustedTextResult(formatSearchResults({ kind, fileResults, contentResults }), {
        query,
        kind,
        path: rootPath,
        fileCount: fileResults.count,
        fileTruncated: fileResults.truncated,
        contentCount: contentResults.matches.length,
        contentTruncated: contentResults.truncated,
      }, "search");
    },
  };
}

export function createGrepTool(app: App, isIgnored: IgnoreMatcher): AgentTool<typeof GrepParameters> {
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
      return untrustedTextResult(formatGrepMatches(matches, matches.length >= maxMatches), {
        pattern: params.pattern,
        count: matches.length,
        truncated: matches.length >= maxMatches,
      }, "grep");
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

function getSearchableFiles(app: App, rootPath: string, isIgnored: IgnoreMatcher): TFile[] {
  return app.vault
    .getFiles()
    .filter((file) => TEXT_EXTENSIONS.has(file.extension.toLowerCase()))
    .filter((file) => !isIgnored(file.path))
    .filter((file) => !rootPath || file.path === rootPath || file.path.startsWith(`${rootPath}/`))
    .sort((left, right) => left.path.localeCompare(right.path));
}
