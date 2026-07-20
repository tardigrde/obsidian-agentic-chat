import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExternalWorkspaceSettings } from "../settings";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { formatSourceReference } from "../retrieval/citations";
import { parseIgnorePatterns } from "../vault/ignore";
import { compileGitignorePatternSource } from "../vault/glob-pattern";
import {
  formatTextSlice,
  readSizeGuardrail,
  resolveLineWindow,
  sliceTextByLines,
  truncateToolOutput,
} from "../vault/truncate";

export const EXTERNAL_INSPECT_TOOL_NAME = "external_inspect";
export const EXTERNAL_REFERENCE_PREFIX = "external://";

const DEFAULT_MAX_LIST_RESULTS = 200;
const MAX_LIST_RESULTS = 500;
const DEFAULT_MAX_SEARCH_RESULTS = 80;
const MAX_SEARCH_RESULTS = 500;
const DEFAULT_MAX_SEARCH_MATCHES = 80;
const MAX_SEARCH_MATCHES = 500;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_READ_FILE_BYTES = 2_000_000;
const MAX_SNIPPET_CHARS = 240;
const EXTERNAL_READ_ARTIFACT_THRESHOLD_CHARS = 12_000;
const EXTERNAL_READ_ARTIFACT_PREVIEW_CHARS = 2_000;
const EXTERNAL_READ_ARTIFACT_CONTENT_TYPE = "text/plain; charset=utf-8";

const ExternalInspectParameters = Type.Object({
  action: Type.String({ description: "One of: list, read, search." }),
  path: Type.Optional(Type.String({ description: "Root-relative path under the configured external root." })),
  query: Type.Optional(Type.String({ description: "Search query for action=search." })),
  kind: Type.Optional(Type.String({ description: "For action=search: both, files, or content. Defaults to both." })),
  startLine: Type.Optional(Type.Number({ description: "For action=read: 1-based first line to read. Alias for offset." })),
  endLine: Type.Optional(Type.Number({ description: "For action=read: 1-based last line to read, inclusive." })),
  offset: Type.Optional(Type.Number({ description: "For action=read: 1-based line to start reading from." })),
  limit: Type.Optional(Type.Number({ description: "For action=read: maximum number of lines to read." })),
  caseSensitive: Type.Optional(Type.Boolean({ description: "For action=search." })),
  regex: Type.Optional(Type.Boolean({ description: "For action=search: treat query as a regular expression." })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum list entries or filename matches." })),
  maxMatches: Type.Optional(Type.Number({ description: "Maximum content matches." })),
});

type ExternalInspectAction = "list" | "read" | "search";
type SearchKind = "both" | "files" | "content";

export interface ExternalWorkspaceRuntime {
  fs: ExternalFsModule;
  path: ExternalPathModule;
  openPath?: (path: string) => Promise<string | undefined>;
}

export interface ExternalWorkspaceToolOptions {
  runtime?: ExternalWorkspaceRuntime;
  cache?: ExternalInspectCache;
  artifactStore?: ToolArtifactStoreLike;
}

export interface ExternalInspectCacheEntry {
  result: AgentToolResult<Record<string, unknown>>;
  hitCount: number;
}

export type ExternalInspectCache = Map<string, ExternalInspectCacheEntry>;

export interface ExternalFsModule {
  promises: {
    realpath(path: string): Promise<string>;
    stat(path: string): Promise<ExternalStats>;
    lstat(path: string): Promise<ExternalStats>;
    readdir(path: string, options?: { withFileTypes?: boolean }): Promise<ExternalDirent[] | string[]>;
    readFile(path: string): Promise<Uint8Array | string>;
  };
}

export interface ExternalPathModule {
  resolve(...paths: string[]): string;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  dirname(path: string): string;
  sep: string;
  isAbsolute(path: string): boolean;
}

export interface ExternalStats {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface ExternalDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface ExternalContext {
  settings: ExternalWorkspaceSettings;
  runtime: ExternalWorkspaceRuntime;
  rootRealPath: string;
  rootDisplayPath: string;
  explicitRules: IgnoreRule[];
}

interface ResolvedExternalPath {
  relPath: string;
  externalRef: string;
  absPath: string;
  realPath: string;
  stats: ExternalStats;
}

interface IgnoreRule {
  basePath: string;
  negated: boolean;
  source: string;
  matcher: RegExp;
}

interface TraversalEntry {
  relPath: string;
  absPath: string;
  realPath: string;
  gitignoreRules: IgnoreRule[];
}

interface FileCandidate {
  relPath: string;
  absPath: string;
  realPath: string;
  stats: ExternalStats;
  gitignoreRules: IgnoreRule[];
}

interface SearchResult {
  path: string;
  line?: number;
  snippet?: string;
  reason: "path" | "content";
}

/**
 * The external workspace surface is registered only when settings enable it and
 * provide one root directory. It is read-only in v1.
 */
export function createExternalWorkspaceTools(
  settings: ExternalWorkspaceSettings,
  options: ExternalWorkspaceToolOptions = {},
): AgentTool[] {
  if (!settings.enabled || !settings.rootPath.trim()) return [];
  return [createExternalInspectTool(settings, options)];
}

export function createExternalInspectTool(
  settings: ExternalWorkspaceSettings,
  options: ExternalWorkspaceToolOptions = {},
): AgentTool<typeof ExternalInspectParameters> {
  return {
    name: EXTERNAL_INSPECT_TOOL_NAME,
    label: "Inspect external root",
    description:
      "Read-only desktop tool for the configured external workspace root. Use action=list, read, or search. " +
      "Paths are root-relative and results cite files as external://path. List/read results are cached; " +
      "for large files or focused questions, prefer read with startLine/endLine or offset/limit. " +
      "reuse prior output instead of repeating the same action/path unless you need a different range or query. " +
      "If a cache or consistency check needs an exact repeat, do it once.",
    parameters: ExternalInspectParameters,
    execute: async (_id, params) => {
      const action = normalizeAction(params.action);
      const context = await createContext(settings, options.runtime);
      switch (action) {
        case "list":
          return cachedExternalInspect(options.cache, externalInspectCacheKey(settings, action, params), () =>
            listExternal(context, params.path, params.maxResults),
          );
        case "read":
          return cachedExternalInspect(options.cache, externalInspectCacheKey(settings, action, params), () =>
            readExternal(context, requiredPath(params.path, "read"), {
              startLine: params.startLine,
              endLine: params.endLine,
              offset: params.offset,
              limit: params.limit,
            }, options.artifactStore),
          );
        case "search":
          return searchExternal(context, {
            path: params.path,
            query: requiredString(params.query, "query"),
            kind: normalizeSearchKind(params.kind),
            caseSensitive: params.caseSensitive,
            regex: params.regex,
            maxResults: params.maxResults,
            maxMatches: params.maxMatches,
          });
      }
    },
  };
}

const MAX_EXTERNAL_INSPECT_CACHE_ENTRIES = 100;

async function cachedExternalInspect(
  cache: ExternalInspectCache | undefined,
  key: string,
  load: () => Promise<AgentToolResult<Record<string, unknown>>>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  if (!cache) return load();
  const cached = cache.get(key);
  if (cached) {
    cached.hitCount += 1;
    if (cached.hitCount > 1) return externalInspectDuplicateGuard(cached.result, cached.hitCount);
    const result = {
      ...cached.result,
      details: { ...cached.result.details, cached: true, cacheHitCount: cached.hitCount },
    };
    return withExternalInspectCacheHint(result, true);
  }
  const result = await load();
  if (cache.size >= MAX_EXTERNAL_INSPECT_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { result, hitCount: 0 });
  return withExternalInspectCacheHint(result, false);
}

function externalInspectDuplicateGuard(
  result: AgentToolResult<Record<string, unknown>>,
  hitCount: number,
): AgentToolResult<Record<string, unknown>> {
  const details = (result.details ?? {});
  const action = typeof details.action === "string" ? details.action : "inspect";
  const target = typeof details.externalRef === "string" ? details.externalRef : "this external path";
  const artifactCitation = typeof details.sourceArtifactCitation === "string" ? details.sourceArtifactCitation : "";
  const artifactHint = artifactCitation
    ? ` The read output is available as ${artifactCitation}; use read_artifact or search_artifact if you need the content again.`
    : "";
  return {
    content: [
      {
        type: "text",
        text:
          `external_inspect duplicate guard: this exact ${action} for ${target} was already returned from cache once this session. ` +
          "Reuse the earlier result instead of repeating this exact call. Use a different path, range, or query only if you need different information." +
          artifactHint,
      },
    ],
    details: {
      ...details,
      cached: true,
      cacheHitCount: hitCount,
      cacheReplaySuppressed: true,
    },
  };
}

function withExternalInspectCacheHint(
  result: AgentToolResult<Record<string, unknown>>,
  cached: boolean,
): AgentToolResult<Record<string, unknown>> {
  const details = (result.details ?? {});
  const action = typeof details.action === "string" ? details.action : "inspect";
  const target = typeof details.externalRef === "string" ? details.externalRef : "this external path";
  const hint = cached
    ? `external_inspect cache hit: this exact ${action} for ${target} was already inspected. Use the cached result above; do not repeat this exact call again.`
    : `external_inspect cache note: this ${action} for ${target} is now cached for the session. Reuse it unless you need a different range/query or the user asks to re-check.`;
  return {
    ...result,
    content: appendTextPart(result.content, `\n\n[${hint}]`),
  };
}

function appendTextPart(
  content: AgentToolResult<Record<string, unknown>>["content"],
  suffix: string,
): AgentToolResult<Record<string, unknown>>["content"] {
  const lastTextIndex = content.map((part) => part.type).lastIndexOf("text");
  if (lastTextIndex < 0) return content;
  return content.map((part, index) =>
    index === lastTextIndex && part.type === "text" ? { ...part, text: `${part.text}${suffix}` } : part,
  );
}

function externalInspectCacheKey(
  settings: ExternalWorkspaceSettings,
  action: "list" | "read",
  params: Record<string, unknown>,
): string {
  const relevant =
    action === "list"
      ? {
          action,
          path: typeof params.path === "string" ? params.path : "",
          maxResults: boundedInt(params.maxResults, DEFAULT_MAX_LIST_RESULTS, 1, MAX_LIST_RESULTS),
        }
      : {
          action,
          path: typeof params.path === "string" ? params.path : "",
          ...resolveLineWindow({
            startLine: typeof params.startLine === "number" ? params.startLine : undefined,
            endLine: typeof params.endLine === "number" ? params.endLine : undefined,
            offset: typeof params.offset === "number" ? params.offset : undefined,
            limit: typeof params.limit === "number" ? params.limit : undefined,
          }),
        };
  return JSON.stringify({
    rootPath: settings.rootPath,
    honorGitignore: settings.honorGitignore,
    ignoredGlobs: settings.ignoredGlobs,
    ...relevant,
  });
}

export function firstExternalReference(text: string, cursorCh?: number): string | null {
  const pattern = /\bexternal:\/\/[^\s<>"'`)\]}]+/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return null;
  if (cursorCh !== undefined) {
    const active = matches.find((match) => {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      return cursorCh >= start && cursorCh <= end;
    });
    if (active) return trimReferencePunctuation(active[0]);
  }
  return trimReferencePunctuation(matches[0][0]);
}

export async function openExternalReference(
  settings: ExternalWorkspaceSettings,
  reference: string,
  runtime?: ExternalWorkspaceRuntime,
): Promise<string> {
  const context = await createContext(settings, runtime);
  const path = reference.trim();
  if (!path.startsWith(EXTERNAL_REFERENCE_PREFIX)) {
    throw new Error(`Expected an ${EXTERNAL_REFERENCE_PREFIX} reference.`);
  }
  const resolved = await resolveExternalPath(context, path, { requireFile: true });
  const opener = context.runtime.openPath;
  if (!opener) {
    throw new Error("Opening external references requires Obsidian desktop with Electron shell access.");
  }
  const result = await opener(resolved.realPath);
  if (result) throw new Error(result);
  return `Opened ${resolved.externalRef}.`;
}

async function createContext(
  settings: ExternalWorkspaceSettings,
  suppliedRuntime?: ExternalWorkspaceRuntime,
): Promise<ExternalContext> {
  if (!settings.enabled) throw new Error("External workspace root tools are disabled.");
  const rootDisplayPath = settings.rootPath.trim();
  if (!rootDisplayPath) throw new Error("External workspace root path is not configured.");

  const runtime = suppliedRuntime ?? requireExternalWorkspaceRuntime();
  const rootPath = runtime.path.resolve(rootDisplayPath);
  let rootRealPath: string;
  let stats: ExternalStats;
  try {
    rootRealPath = await runtime.fs.promises.realpath(rootPath);
    stats = await runtime.fs.promises.stat(rootRealPath);
  } catch {
    throw new Error(`External workspace root "${rootDisplayPath}" does not exist or cannot be read.`);
  }
  if (!stats.isDirectory()) throw new Error(`External workspace root "${rootDisplayPath}" is not a directory.`);
  return {
    settings,
    runtime,
    rootRealPath,
    rootDisplayPath,
    explicitRules: parseIgnoreRules(parseIgnorePatterns(settings.ignoredGlobs), ""),
  };
}

async function listExternal(
  context: ExternalContext,
  rawPath: string | undefined,
  rawMaxResults: number | undefined,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const resolved = await resolveExternalPath(context, rawPath ?? "", { requireDirectory: true });
  const gitignoreRules = await gitignoreRulesForPath(context, resolved.relPath, true);
  const entries = await context.runtime.fs.promises.readdir(resolved.realPath, { withFileTypes: true });
  const maxResults = boundedInt(rawMaxResults, DEFAULT_MAX_LIST_RESULTS, 1, MAX_LIST_RESULTS);
  const rows: string[] = [];
  let hidden = 0;

  for (const entry of normalizeDirents(entries)) {
    if (rows.length >= maxResults) break;
    const childRel = joinRelPath(resolved.relPath, entry.name);
    if (isIgnored(context, childRel, [...gitignoreRules])) {
      hidden += 1;
      continue;
    }
    const childAbs = context.runtime.path.join(resolved.realPath, entry.name);
    const child = await safeResolveChild(context, childRel, childAbs);
    if (!child) {
      hidden += 1;
      continue;
    }
    const suffix = child.stats.isDirectory() ? "/" : "";
    const type = fileType(child.stats);
    const size = child.stats.isFile() ? `, ${child.stats.size} bytes` : "";
    rows.push(`${externalRef(child.relPath)}${suffix} (${type}${size})`);
  }

  const truncated = normalizeDirents(entries).length > rows.length + hidden;
  const emptyHint = resolved.relPath ? "/" : "";
  const text = rows.length
    ? rows.join("\n")
    : `No visible entries under ${resolved.externalRef}${emptyHint}.`;
  return textResult(truncated ? `${text}\n[Results truncated at ${maxResults} entries.]` : text, {
    action: "list",
    path: resolved.relPath,
    externalRef: resolved.externalRef,
    hidden,
    maxResults,
    truncated,
  });
}

async function readExternal(
  context: ExternalContext,
  rawPath: string,
  range: { startLine?: number; endLine?: number; offset?: number; limit?: number },
  artifactStore?: ToolArtifactStoreLike,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const resolved = await resolveExternalPath(context, rawPath, { requireFile: true });
  if (resolved.stats.size > MAX_READ_FILE_BYTES) {
    return textResult(
      `${resolved.externalRef} is too large to read safely (${resolved.stats.size.toLocaleString()} bytes). Use search or a smaller file.`,
      {
        action: "read",
        path: resolved.relPath,
        externalRef: resolved.externalRef,
        size: resolved.stats.size,
        refused: "too-large",
      },
    );
  }
  const window = resolveLineWindow(range);
  const guard = readSizeGuardrail({ path: resolved.externalRef, size: resolved.stats.size, ...range });
  if (guard) {
    return textResult(guard, {
      action: "read",
      path: resolved.relPath,
      externalRef: resolved.externalRef,
      size: resolved.stats.size,
      refused: "bulk-too-large",
    });
  }
  const bytes = await context.runtime.fs.promises.readFile(resolved.realPath);
  if (isBinaryData(bytes)) {
    return textResult(`${resolved.externalRef} appears to be binary; external_inspect only reads text files.`, {
      action: "read",
      path: resolved.relPath,
      externalRef: resolved.externalRef,
      size: resolved.stats.size,
      refused: "binary",
    });
  }
  const content = decodeText(bytes);
  const slice = sliceTextByLines(content, window);
  const formatted = formatTextSlice(resolved.externalRef, slice);
  const details = {
    action: "read",
    path: resolved.relPath,
    externalRef: resolved.externalRef,
    startLine: slice.startLine,
    endLine: slice.endLine,
    totalLines: slice.totalLines,
    truncated: slice.truncated,
  };
  return maybeArtifactizeExternalRead(artifactStore, formatted, details);
}

async function maybeArtifactizeExternalRead(
  artifactStore: ToolArtifactStoreLike | undefined,
  text: string,
  details: Record<string, unknown>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  if (!artifactStore || text.length <= EXTERNAL_READ_ARTIFACT_THRESHOLD_CHARS) return textResult(text, details);

  const externalRef = typeof details.externalRef === "string" ? details.externalRef : "external://";
  const label = externalReadArtifactLabel(externalRef, details);
  const sourceTextHash = hashText(text);
  const startLine = typeof details.startLine === "number" ? details.startLine.toString() : "";
  const endLine = typeof details.endLine === "number" ? details.endLine.toString() : "";
  const dedupKey = `external:${externalRef}:${startLine}:${endLine}:${sourceTextHash}`;
  const existing = await artifactStore.findArtifactByDedupKey?.(dedupKey);
  const metadata =
    existing?.metadata ??
    (await artifactStore.writeArtifact({
      label,
      sourceToolName: EXTERNAL_INSPECT_TOOL_NAME,
      text,
      contentType: EXTERNAL_READ_ARTIFACT_CONTENT_TYPE,
      dedupKey,
      sourceUrl: externalRef,
      sourceKind: "external",
      sourceTextHash,
      pinned: true,
    }));
  const artifactCitation = formatSourceReference({
    type: "artifact",
    artifactId: metadata.id,
    label,
  });
  const preview = truncateToolOutput(text, EXTERNAL_READ_ARTIFACT_PREVIEW_CHARS);
  return textResult(
    [
      `${label} stored as an artifact because the read output is ${text.length.toLocaleString()} characters.`,
      `External read artifact: ${artifactCitation}${existing ? " (already imported)" : ""}`,
      "Use read_artifact or search_artifact with the artifact id to inspect the full content.",
      "",
      "Preview:",
      preview,
    ].join("\n"),
    {
      ...details,
      sourceArtifactId: metadata.id,
      sourceArtifactCitation: artifactCitation,
      sourceArtifactDuplicate: Boolean(existing),
      artifacted: true,
      returnedChars: preview.length,
      totalChars: text.length,
    },
  );
}

function externalReadArtifactLabel(externalRef: string, details: Record<string, unknown>): string {
  const startLine = typeof details.startLine === "number" ? details.startLine : null;
  const endLine = typeof details.endLine === "number" ? details.endLine : null;
  if (startLine !== null && endLine !== null) return `${externalRef} lines ${startLine}-${endLine}`;
  return externalRef;
}

async function searchExternal(
  context: ExternalContext,
  options: {
    path?: string;
    query: string;
    kind: SearchKind;
    caseSensitive?: boolean;
    regex?: boolean;
    maxResults?: number;
    maxMatches?: number;
  },
): Promise<AgentToolResult<Record<string, unknown>>> {
  const root = await resolveExternalPath(context, options.path ?? "", { requireDirectory: true });
  const matcher = createSearchMatcher(options.query, Boolean(options.caseSensitive), Boolean(options.regex));
  const maxResults = boundedInt(options.maxResults, DEFAULT_MAX_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
  const maxMatches = boundedInt(options.maxMatches, DEFAULT_MAX_SEARCH_MATCHES, 1, MAX_SEARCH_MATCHES);
  const results: SearchResult[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;

  for await (const file of walkFiles(context, root)) {
    if (results.length >= maxResults + maxMatches) break;
    if (options.kind !== "content" && matcher.test(file.relPath)) {
      results.push({ path: file.relPath, reason: "path" });
      if (results.filter((result) => result.reason === "path").length >= maxResults && options.kind === "files") break;
    }
    if (options.kind === "files") continue;
    if (results.filter((result) => result.reason === "content").length >= maxMatches) continue;
    if (!file.stats.isFile() || file.stats.size > MAX_SEARCH_FILE_BYTES) {
      filesSkipped += 1;
      continue;
    }
    const bytes = await context.runtime.fs.promises.readFile(file.realPath);
    if (isBinaryData(bytes)) {
      filesSkipped += 1;
      continue;
    }
    filesScanned += 1;
    const lines = decodeText(bytes).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher.test(lines[index])) continue;
      results.push({
        path: file.relPath,
        line: index + 1,
        snippet: trimSnippet(lines[index]),
        reason: "content",
      });
      if (results.filter((result) => result.reason === "content").length >= maxMatches) break;
    }
  }

  const emptyHint = root.relPath ? "/" : "";
  const text = results.length
    ? results.map(formatSearchResult).join("\n")
    : `No external matches for "${options.query}" under ${root.externalRef}${emptyHint}.`;
  return textResult(truncateToolOutput(text), {
    action: "search",
    path: root.relPath,
    externalRef: root.externalRef,
    query: options.query,
    kind: options.kind,
    results: results.length,
    filesScanned,
    filesSkipped,
    maxResults,
    maxMatches,
  });
}

async function* walkFiles(context: ExternalContext, root: ResolvedExternalPath): AsyncGenerator<FileCandidate> {
  const initialRules = await gitignoreRulesForPath(context, root.relPath, true);
  const stack: TraversalEntry[] = [
    {
      relPath: root.relPath,
      absPath: root.absPath,
      realPath: root.realPath,
      gitignoreRules: initialRules,
    },
  ];
  const visitedDirs = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visitedDirs.has(current.realPath)) continue;
    visitedDirs.add(current.realPath);
    const rules = await rulesWithDirectoryGitignore(context, current.relPath, current.realPath, current.gitignoreRules);
    const entries = await context.runtime.fs.promises.readdir(current.realPath, { withFileTypes: true });
    for (const entry of normalizeDirents(entries)) {
      const childRel = joinRelPath(current.relPath, entry.name);
      if (isIgnored(context, childRel, rules)) continue;
      const childAbs = context.runtime.path.join(current.realPath, entry.name);
      const child = await safeResolveChild(context, childRel, childAbs);
      if (!child) continue;
      if (child.stats.isDirectory()) {
        stack.push({ relPath: child.relPath, absPath: child.absPath, realPath: child.realPath, gitignoreRules: rules });
      } else if (child.stats.isFile()) {
        yield { ...child, gitignoreRules: rules };
      }
    }
  }
}

async function resolveExternalPath(
  context: ExternalContext,
  rawPath: string,
  constraints: { requireFile?: boolean; requireDirectory?: boolean } = {},
): Promise<ResolvedExternalPath> {
  const relPath = normalizeExternalPath(context, rawPath);
  if (isIgnored(context, relPath, await gitignoreRulesForPath(context, relPath, constraints.requireDirectory))) {
    throw new Error(`${externalRef(relPath)} is ignored or hidden.`);
  }
  const absPath = relPath ? context.runtime.path.join(context.rootRealPath, ...relPath.split("/")) : context.rootRealPath;
  let realPath: string;
  let stats: ExternalStats;
  try {
    realPath = await context.runtime.fs.promises.realpath(absPath);
    stats = await context.runtime.fs.promises.stat(realPath);
  } catch {
    throw new Error(`${externalRef(relPath)} was not found.`);
  }
  if (!isInsideRoot(context, realPath)) throw new Error(`${externalRef(relPath)} points outside the external root.`);
  if (constraints.requireFile && !stats.isFile()) throw new Error(`${externalRef(relPath)} is not a file.`);
  if (constraints.requireDirectory && !stats.isDirectory()) throw new Error(`${externalRef(relPath)} is not a directory.`);
  return { relPath, externalRef: externalRef(relPath), absPath, realPath, stats };
}

async function safeResolveChild(
  context: ExternalContext,
  relPath: string,
  absPath: string,
): Promise<ResolvedExternalPath | null> {
  try {
    const realPath = await context.runtime.fs.promises.realpath(absPath);
    if (!isInsideRoot(context, realPath)) return null;
    const stats = await context.runtime.fs.promises.stat(realPath);
    return { relPath, externalRef: externalRef(relPath), absPath, realPath, stats };
  } catch {
    return null;
  }
}

async function gitignoreRulesForPath(
  context: ExternalContext,
  relPath: string,
  isDirectory = false,
): Promise<IgnoreRule[]> {
  if (!context.settings.honorGitignore) return [];
  const dirs = ancestorDirs(isDirectory ? relPath : parentRelPath(relPath));
  let rules: IgnoreRule[] = [];
  for (const dir of dirs) {
    const absDir = dir ? context.runtime.path.join(context.rootRealPath, ...dir.split("/")) : context.rootRealPath;
    rules = await rulesWithDirectoryGitignore(context, dir, absDir, rules);
  }
  return rules;
}

async function rulesWithDirectoryGitignore(
  context: ExternalContext,
  dirRelPath: string,
  dirAbsPath: string,
  existing: IgnoreRule[],
): Promise<IgnoreRule[]> {
  if (!context.settings.honorGitignore) return existing;
  const gitignorePath = context.runtime.path.join(dirAbsPath, ".gitignore");
  try {
    const raw = decodeText(await context.runtime.fs.promises.readFile(gitignorePath));
    const rules = parseGitignoreRules(raw, dirRelPath);
    return rules.length ? [...existing, ...rules] : existing;
  } catch {
    return existing;
  }
}

function isIgnored(context: ExternalContext, relPath: string, gitignoreRules: IgnoreRule[]): boolean {
  if (!relPath) return false;
  return evaluateIgnoreRules(relPath, [...context.explicitRules, ...gitignoreRules]);
}

function evaluateIgnoreRules(relPath: string, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (!pathIsInsideBase(relPath, rule.basePath)) continue;
    const scopedPath = stripBasePath(relPath, rule.basePath);
    if (rule.matcher.test(scopedPath)) ignored = !rule.negated;
  }
  return ignored;
}

function parseGitignoreRules(contents: string, basePath: string): IgnoreRule[] {
  return parseIgnoreRuleLines(contents.split(/\r?\n/), basePath);
}

function parseIgnoreRules(patterns: string[], basePath: string): IgnoreRule[] {
  return parseIgnoreRuleLines(patterns, basePath);
}

function parseIgnoreRuleLines(lines: string[], basePath: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1).trim();
    }
    if (!line) continue;
    const source = compileGitignorePatternSource(line);
    if (!source) continue;
    rules.push({
      basePath,
      negated,
      source: line,
      matcher: new RegExp(source, "i"),
    });
  }
  return rules;
}

function createSearchMatcher(query: string, caseSensitive: boolean, regex: boolean): { test: (text: string) => boolean } {
  if (regex) {
    let expression: RegExp;
    try {
      expression = new RegExp(query, caseSensitive ? "" : "i");
    } catch (error) {
      throw new Error(`Invalid search regex: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return { test: (text) => expression.test(text) };
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  return { test: (text) => (caseSensitive ? text : text.toLowerCase()).includes(needle) };
}

function fileType(stats: ExternalStats): string {
  if (stats.isDirectory()) return "dir";
  if (stats.isFile()) return "file";
  return "other";
}

function normalizeAction(value: unknown): ExternalInspectAction {
  if (value === "list" || value === "read" || value === "search") return value;
  throw new Error("external_inspect: action must be list, read, or search.");
}

function normalizeSearchKind(value: unknown): SearchKind {
  if (value === "files" || value === "content" || value === "both") return value;
  return "both";
}

function requiredPath(value: unknown, action: string): string {
  const text = requiredString(value, "path");
  if (!text) throw new Error(`external_inspect: path is required for action=${action}.`);
  return text;
}

function requiredString(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`external_inspect: ${name} is required.`);
  return text;
}

function normalizeExternalPath(context: ExternalContext, rawPath: string): string {
  let text = (rawPath ?? "").trim();
  if (text.startsWith(EXTERNAL_REFERENCE_PREFIX)) text = text.slice(EXTERNAL_REFERENCE_PREFIX.length);
  text = text.replaceAll("\\", "/");
  if (!text || text === "/") return "";
  if (isAbsoluteExternalPath(context, text)) {
    const absolute = context.runtime.path.resolve(text);
    const relative = context.runtime.path.relative(context.rootRealPath, absolute).replaceAll("\\", "/");
    if (!relative) return "";
    if (relative.startsWith("..") || context.runtime.path.isAbsolute(relative)) {
      throw new Error("external_inspect absolute paths must be inside the configured external root.");
    }
    text = relative;
  }
  const segments: string[] = [];
  for (const segment of text.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") throw new Error("external_inspect paths cannot escape the configured external root.");
    segments.push(segment);
  }
  return segments.join("/");
}

function isAbsoluteExternalPath(context: ExternalContext, path: string): boolean {
  return context.runtime.path.isAbsolute(path) || /^[A-Za-z]:\//.test(path);
}

function normalizeDirents(entries: ExternalDirent[] | string[]): ExternalDirent[] {
  return entries.map((entry) => {
    if (typeof entry !== "string") return entry;
    return {
      name: entry,
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    };
  });
}

function isInsideRoot(context: ExternalContext, realPath: string): boolean {
  const relative = context.runtime.path.relative(context.rootRealPath, realPath);
  return relative === "" || (!relative.startsWith("..") && !context.runtime.path.isAbsolute(relative));
}

function joinRelPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function parentRelPath(relPath: string): string {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? "" : relPath.slice(0, index);
}

function ancestorDirs(relDirPath: string): string[] {
  const dirs = [""];
  if (!relDirPath) return dirs;
  const segments = relDirPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = joinRelPath(current, segment);
    dirs.push(current);
  }
  return dirs;
}

function pathIsInsideBase(relPath: string, basePath: string): boolean {
  return !basePath || relPath === basePath || relPath.startsWith(`${basePath}/`);
}

function stripBasePath(relPath: string, basePath: string): string {
  if (!basePath) return relPath;
  if (relPath === basePath) return "";
  return relPath.slice(basePath.length + 1);
}

function externalRef(relPath: string): string {
  return `${EXTERNAL_REFERENCE_PREFIX}${relPath}`;
}

function formatSearchResult(result: SearchResult): string {
  const ref = externalRef(result.path);
  if (result.reason === "path") return `${ref} (path match)`;
  return `${ref}:${result.line}: ${result.snippet ?? ""}`;
}

function trimSnippet(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ");
  return compact.length > MAX_SNIPPET_CHARS ? `${compact.slice(0, MAX_SNIPPET_CHARS)}…` : compact;
}

function trimReferencePunctuation(reference: string): string {
  return reference.replace(/[.,;:]+$/g, "");
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(stringFromPrimitive(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function stringFromPrimitive(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString();
  return "";
}

function isBinaryData(data: Uint8Array | string): boolean {
  if (typeof data === "string") return data.includes("\u0000");
  const limit = Math.min(data.byteLength, 4096);
  for (let index = 0; index < limit; index += 1) {
    if (data[index] === 0) return true;
  }
  return false;
}

function decodeText(data: Uint8Array | string): string {
  if (typeof data === "string") return data;
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details };
}

function requireExternalWorkspaceRuntime(): ExternalWorkspaceRuntime {
  const requireFn = optionalNodeRequire();
  if (!requireFn) {
    throw new Error("External workspace root tools require Obsidian desktop with filesystem access.");
  }
  try {
    const fs = requireFn("fs") as ExternalFsModule;
    const path = requireFn("path") as ExternalPathModule;
    const shell = optionalElectronShell(requireFn);
    if (!fs.promises || typeof fs.promises.realpath !== "function" || typeof path.resolve !== "function") {
      throw new Error("missing filesystem support");
    }
    const openPath = shell?.openPath;
    return {
      fs,
      path,
      openPath: openPath ? (target) => openPath(target) : undefined,
    };
  } catch (error) {
    throw new Error(
      `External workspace root tools require Obsidian desktop with filesystem access: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function optionalNodeRequire(): ((moduleName: string) => unknown) | undefined {
  const candidate = (window as { require?: (moduleName: string) => unknown }).require;
  return typeof candidate === "function" ? candidate : undefined;
}

function optionalElectronShell(requireFn: (moduleName: string) => unknown): { openPath?: (path: string) => Promise<string> } | null {
  try {
    const electron = requireFn("electron") as { shell?: { openPath?: (path: string) => Promise<string> } };
    return electron.shell ?? null;
  } catch {
    return null;
  }
}
