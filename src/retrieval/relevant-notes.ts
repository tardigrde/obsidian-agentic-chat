import type { App, TFile } from "obsidian";
import type { IgnoreMatcher } from "../vault/ignore";
import { applyRetrievalRankingControls, buildRetrievalDiagnostics } from "./diagnostics";
import { retrieveLexicalVaultCandidates } from "./lexical";
import type { RetrievalDocument } from "./policy";
import { isPathInProjectScope } from "../projects/projects";
import type { EmbeddingIndexSnapshot } from "./embeddings";
import { mergeSemanticCandidates, retrieveSemanticCandidatesForDocument } from "./semantic";

export interface RelevantNotesControls {
  pinnedPaths?: readonly string[];
  excludedPaths?: readonly string[];
}

export interface RelevantNoteSuggestion {
  path: string;
  title: string;
  score: number;
  snippets: readonly string[];
  why: readonly string[];
  pinned: boolean;
}

export type RelevantNotesEmptyReason =
  | "no-active-note"
  | "active-note-ignored"
  | "active-note-missing"
  | "no-related-notes";

export interface RelevantNotesPanelState {
  activePath: string | null;
  suggestions: readonly RelevantNoteSuggestion[];
  ignoredCount: number;
  emptyReason: RelevantNotesEmptyReason | null;
}

export interface RelevantNotesStateInput {
  activePath: string | null;
  documents: readonly RetrievalDocument[];
  ignoreMatcher?: IgnoreMatcher;
  controls?: RelevantNotesControls;
  scopeFolders?: readonly string[];
  semanticIndex?: EmbeddingIndexSnapshot | null;
  maxResults?: number;
  now?: number;
}

const DEFAULT_RELEVANT_NOTES_LIMIT = 5;
const QUERY_CONTENT_TERM_LIMIT = 80;
const RELEVANT_NOTES_STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "but",
  "for",
  "from",
  "has",
  "have",
  "into",
  "md",
  "not",
  "note",
  "notes",
  "see",
  "that",
  "the",
  "this",
  "with",
]);

export async function loadVaultRetrievalDocuments(
  app: App,
  ignoreMatcher?: IgnoreMatcher,
  scopeFolders?: readonly string[],
): Promise<RetrievalDocument[]> {
  const files = (app.vault as App["vault"] & { getMarkdownFiles: () => TFile[]; cachedRead: (file: TFile) => Promise<string> })
    .getMarkdownFiles()
    .filter((file) => !ignoreMatcher?.(file.path) && isPathInProjectScope(file.path, scopeFolders ?? []));
  const documents = await Promise.all(
    files.map(async (file) =>
      markdownToRetrievalDocument({
        id: file.path,
        path: file.path,
        basename: file.basename,
        modifiedTime: (file as { stat?: { mtime?: number } }).stat?.mtime,
        content: await app.vault.cachedRead(file),
      }),
    ),
  );
  return withBacklinks(documents);
}

export function buildRelevantNotesPanelState(input: RelevantNotesStateInput): RelevantNotesPanelState {
  const documents = withBacklinks(
    input.documents.filter((document) => isPathInProjectScope(document.path, input.scopeFolders ?? [])),
  );
  if (!input.activePath) {
    return emptyState(null, "no-active-note", 0);
  }
  if (input.ignoreMatcher?.(input.activePath)) {
    return emptyState(input.activePath, "active-note-ignored", 0);
  }

  const activePath = normalizePath(input.activePath);
  const active = documents.find((document) => normalizePath(document.path) === activePath);
  if (!active) {
    return emptyState(input.activePath, "active-note-missing", 0);
  }

  const searchable = documents.filter((document) => normalizePath(document.path) !== activePath);
  const lexicalResponse = retrieveLexicalVaultCandidates(
    {
      text: relevantNotesQuerySeed(active),
      activePath: input.activePath,
      maxResults: Math.max(searchable.length, input.maxResults ?? DEFAULT_RELEVANT_NOTES_LIMIT),
      now: input.now,
    },
    {
      documents: searchable,
      ignoreMatcher: input.ignoreMatcher,
      maxResults: Math.max(searchable.length, input.maxResults ?? DEFAULT_RELEVANT_NOTES_LIMIT),
      maxSnippetsPerDocument: 1,
    },
  );
  const response = mergeSemanticCandidates(
    lexicalResponse,
    retrieveSemanticCandidatesForDocument({
      seed: active,
      documents: searchable,
      snapshot: input.semanticIndex,
      maxResults: Math.max(searchable.length, input.maxResults ?? DEFAULT_RELEVANT_NOTES_LIMIT),
    }),
    { maxResults: Math.max(searchable.length, input.maxResults ?? DEFAULT_RELEVANT_NOTES_LIMIT) },
  );
  const controlled = applyRetrievalRankingControls(response.results, input.controls).slice(
    0,
    input.maxResults ?? DEFAULT_RELEVANT_NOTES_LIMIT,
  );
  const diagnostics = buildRetrievalDiagnostics(
    { ...response, results: controlled, totalMatches: controlled.length },
    { controls: input.controls },
  );
  const pinned = normalizedSet(input.controls?.pinnedPaths);
  const suggestions = diagnostics.results.map((result) => {
    const source = controlled.find((candidate) => candidate.document.path === result.path);
    return {
      path: result.path,
      title: result.title,
      score: result.score,
      snippets: source?.snippets ?? [],
      why: result.why,
      pinned: pinned.has(normalizePath(result.path)),
    };
  });

  return {
    activePath: input.activePath,
    suggestions,
    ignoredCount: response.ignoredCount,
    emptyReason: suggestions.length === 0 ? "no-related-notes" : null,
  };
}

export function pinRelevantNote(controls: RelevantNotesControls, path: string): RelevantNotesControls {
  const normalized = normalizePath(path);
  const pinned = normalizedSet(controls.pinnedPaths);
  pinned.add(normalized);
  return {
    pinnedPaths: [...pinned],
    excludedPaths: [...normalizedSet(controls.excludedPaths)].filter((entry) => entry !== normalized),
  };
}

export function unpinRelevantNote(controls: RelevantNotesControls, path: string): RelevantNotesControls {
  const normalized = normalizePath(path);
  return {
    pinnedPaths: [...normalizedSet(controls.pinnedPaths)].filter((entry) => entry !== normalized),
    excludedPaths: [...normalizedSet(controls.excludedPaths)],
  };
}

export function excludeRelevantNote(controls: RelevantNotesControls, path: string): RelevantNotesControls {
  const normalized = normalizePath(path);
  const excluded = normalizedSet(controls.excludedPaths);
  excluded.add(normalized);
  return {
    pinnedPaths: [...normalizedSet(controls.pinnedPaths)].filter((entry) => entry !== normalized),
    excludedPaths: [...excluded],
  };
}

export function markdownToRetrievalDocument(input: {
  id: string;
  path: string;
  basename: string;
  content: string;
  modifiedTime?: number;
}): RetrievalDocument {
  const { frontmatter, body } = splitFrontmatter(input.content);
  const aliases = stringList(frontmatter.aliases ?? frontmatter.alias);
  const frontmatterTags = stringList(frontmatter.tags ?? frontmatter.tag);
  const contentTags = extractTags(body);
  return {
    id: input.id,
    path: input.path,
    title: firstHeading(body) ?? input.basename,
    content: body,
    language: typeof frontmatter.lang === "string" ? frontmatter.lang : undefined,
    tags: [...new Set([...frontmatterTags, ...contentTags])],
    aliases,
    frontmatter,
    links: extractWikiLinks(body),
    backlinks: [],
    modifiedTime: input.modifiedTime,
  };
}

function withBacklinks(documents: readonly RetrievalDocument[]): RetrievalDocument[] {
  const byPath = new Map(documents.map((document) => [normalizePath(document.path), document]));
  const backlinks = new Map<string, string[]>();
  for (const document of documents) {
    for (const link of document.links ?? []) {
      const target = resolveLinkedPath(link, byPath);
      if (!target) continue;
      const list = backlinks.get(target) ?? [];
      list.push(document.path);
      backlinks.set(target, list);
    }
  }
  return documents.map((document) => ({
    ...document,
    backlinks: backlinks.get(normalizePath(document.path)) ?? [],
  }));
}

function relevantNotesQuerySeed(active: RetrievalDocument): string {
  return [
    active.title,
    ...(active.tags ?? []),
    ...(active.aliases ?? []),
    ...(active.links ?? []).map(linkSeedTerm),
    ...(active.backlinks ?? []).map(linkSeedTerm),
    frontmatterText(active.frontmatter),
    importantContentTerms(active.content).join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

function importantContentTerms(content: string): readonly string[] {
  const terms = new Set<string>();
  const searchable = content.replace(/\[\[([^\]|#^]+)(?:[#^|][^\]]*)?]]/g, (_match, target: string) =>
    linkSeedTerm(target),
  );
  for (const match of searchable.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}/_-]*/gu)) {
    const term = match[0];
    if (term.length < 3 || RELEVANT_NOTES_STOPWORDS.has(term)) continue;
    terms.add(term);
    if (terms.size >= QUERY_CONTENT_TERM_LIMIT) break;
  }
  return [...terms];
}

function linkSeedTerm(path: string): string {
  return path
    .split("/")
    .pop()
    ?.replace(/\.md$/i, "")
    .replace(/[_-]+/g, " ")
    .trim() ?? "";
}

function splitFrontmatter(content: string): {
  frontmatter: Record<string, string | readonly string[]>;
  body: string;
} {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: normalized };
  const yaml = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, "");
  return { frontmatter: parseSimpleYaml(yaml), body };
}

function parseSimpleYaml(yaml: string): Record<string, string | readonly string[]> {
  const data: Record<string, string | readonly string[]> = {};
  for (const line of yaml.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    data[match[1]] = parseYamlValue(match[2]);
  }
  return data;
}

function parseYamlValue(value: string): string | readonly string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => stripQuotes(item.trim()))
      .filter(Boolean);
  }
  return stripQuotes(trimmed);
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function stringList(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(String).map(normalizeTag).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map(normalizeTag)
      .filter(Boolean);
  }
  return [];
}

function firstHeading(body: string): string | undefined {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return match?.[1].trim();
}

function extractTags(body: string): readonly string[] {
  const tags = new Set<string>();
  for (const match of body.matchAll(/(?:^|\s)#([\p{L}\p{N}/_-]+)/gu)) {
    const tag = normalizeTag(match[1]);
    if (tag) tags.add(tag);
  }
  return [...tags];
}

function extractWikiLinks(body: string): readonly string[] {
  const links: string[] = [];
  for (const match of body.matchAll(/\[\[([^\]|#^]+)(?:[#^|][^\]]*)?]]/g)) {
    const target = normalizeLinkedTarget(match[1]);
    if (target) links.push(target);
  }
  return [...new Set(links)];
}

function resolveLinkedPath(link: string, byPath: Map<string, RetrievalDocument>): string | null {
  const normalized = normalizePath(link);
  if (byPath.has(normalized)) return normalized;
  const withExtension = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
  if (byPath.has(withExtension)) return withExtension;
  const basenameMatch = [...byPath.keys()].find((path) => path.split("/").pop()?.replace(/\.md$/i, "") === normalized);
  return basenameMatch ?? null;
}

function normalizeLinkedTarget(target: string): string | undefined {
  const trimmed = target.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  return trimmed || undefined;
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

function normalizePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/").toLowerCase();
}

function normalizedSet(paths: readonly string[] | undefined): Set<string> {
  return new Set((paths ?? []).map(normalizePath));
}

function frontmatterText(frontmatter: RetrievalDocument["frontmatter"]): string {
  return Object.entries(frontmatter ?? {})
    .map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(" ") : String(value)}`)
    .join(" ");
}

function emptyState(activePath: string | null, emptyReason: RelevantNotesEmptyReason, ignoredCount: number): RelevantNotesPanelState {
  return { activePath, suggestions: [], ignoredCount, emptyReason };
}
