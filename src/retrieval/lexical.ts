import type { IgnoreMatcher } from "../vault/ignore";
import type { RetrievalDocument, RetrievalSignalKind } from "./policy";

export interface LexicalVaultQaQuery {
  text: string;
  activePath?: string;
  now?: number;
  offset?: number;
  maxResults?: number;
}

export interface LexicalVaultQaOptions {
  documents: readonly RetrievalDocument[];
  ignoreMatcher?: IgnoreMatcher;
  maxResults?: number;
  maxSnippetsPerDocument?: number;
}

export interface LexicalRetrievalSignalMatch {
  kind: RetrievalSignalKind;
  score: number;
  detail: string;
  matches: readonly string[];
}

export interface LexicalVaultQaResult {
  document: RetrievalDocument;
  score: number;
  signals: readonly LexicalRetrievalSignalMatch[];
  snippets: readonly string[];
}

export interface LexicalVaultQaResponse {
  queryTokens: readonly string[];
  results: readonly LexicalVaultQaResult[];
  totalMatches: number;
  ignoredCount: number;
  offset: number;
  nextOffset?: number;
  hasMore: boolean;
}

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_SNIPPETS_PER_DOCUMENT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const SIGNAL_WEIGHTS: Record<Exclude<RetrievalSignalKind, "semantic">, number> = {
  path: 1.4,
  title: 1.8,
  body: 0.8,
  tag: 1.3,
  frontmatter: 1.2,
  alias: 1.5,
  link: 1.1,
  backlink: 1.1,
  recency: 0.6,
  "active-note": 1.6,
};

export function retrieveLexicalVaultCandidates(
  query: LexicalVaultQaQuery,
  options: LexicalVaultQaOptions,
): LexicalVaultQaResponse {
  const queryTokens = tokenizeRetrievalQuery(query.text);
  const offset = Math.max(0, query.offset ?? 0);
  const maxResults = Math.max(1, query.maxResults ?? options.maxResults ?? DEFAULT_MAX_RESULTS);
  const maxSnippets = Math.max(0, options.maxSnippetsPerDocument ?? DEFAULT_MAX_SNIPPETS_PER_DOCUMENT);
  const activePath = query.activePath ? normalizePath(query.activePath) : undefined;
  const candidates: LexicalVaultQaResult[] = [];
  let ignoredCount = 0;

  for (const document of options.documents) {
    if (options.ignoreMatcher?.(document.path)) {
      ignoredCount += 1;
      continue;
    }

    const result = scoreDocument(document, queryTokens, {
      activePath,
      now: query.now,
      maxSnippets,
    });
    if (result) candidates.push(result);
  }

  candidates.sort(compareResults);
  const results = candidates.slice(offset, offset + maxResults);
  const nextOffset = offset + results.length;
  const hasMore = nextOffset < candidates.length;

  return {
    queryTokens,
    results,
    totalMatches: candidates.length,
    ignoredCount,
    offset,
    nextOffset: hasMore ? nextOffset : undefined,
    hasMore,
  };
}

export function tokenizeRetrievalQuery(text: string): readonly string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  return [...new Set(matches.filter((token) => token.length >= 2))];
}

function scoreDocument(
  document: RetrievalDocument,
  queryTokens: readonly string[],
  options: { activePath?: string; now?: number; maxSnippets: number },
): LexicalVaultQaResult | null {
  const signals: LexicalRetrievalSignalMatch[] = [];
  const snippets = collectSnippets(document.content, queryTokens, options.maxSnippets);

  pushTextSignal(signals, "path", document.path, queryTokens, "path");
  pushTextSignal(signals, "title", document.title, queryTokens, "title");
  pushTextSignal(signals, "body", document.content, queryTokens, "body");
  pushTextSignal(signals, "tag", document.tags?.join(" ") ?? "", queryTokens, "tags");
  pushTextSignal(signals, "alias", document.aliases?.join(" ") ?? "", queryTokens, "aliases");
  pushTextSignal(signals, "frontmatter", frontmatterText(document), queryTokens, "frontmatter");
  pushTextSignal(signals, "link", graphText(document.links), queryTokens, "links");
  pushTextSignal(signals, "backlink", graphText(document.backlinks), queryTokens, "backlinks");

  const hasContentMatch = signals.length > 0;
  const activeSignal = activeNoteSignal(document, options.activePath);
  if (activeSignal) signals.push(activeSignal);
  if ((hasContentMatch || activeSignal) && options.now !== undefined) {
    const recency = recencySignal(document, options.now);
    if (recency) signals.push(recency);
  }

  if (signals.length === 0) return null;
  const score = Number(signals.reduce((sum, signal) => sum + signal.score, 0).toFixed(6));
  return { document, score, signals, snippets };
}

function pushTextSignal(
  signals: LexicalRetrievalSignalMatch[],
  kind: Exclude<RetrievalSignalKind, "semantic">,
  value: string,
  queryTokens: readonly string[],
  detail: string,
): void {
  const matches = matchedTokens(value, queryTokens);
  if (matches.length === 0) return;
  signals.push({
    kind,
    score: Number((matches.length * SIGNAL_WEIGHTS[kind]).toFixed(6)),
    detail,
    matches,
  });
}

function activeNoteSignal(
  document: RetrievalDocument,
  activePath: string | undefined,
): LexicalRetrievalSignalMatch | null {
  if (!activePath) return null;
  const documentPath = normalizePath(document.path);
  const links = new Set([...(document.links ?? []), ...(document.backlinks ?? [])].map(normalizePath));
  if (documentPath !== activePath && !links.has(activePath)) return null;
  return {
    kind: "active-note",
    score: SIGNAL_WEIGHTS["active-note"],
    detail: documentPath === activePath ? "active note" : "linked to active note",
    matches: [activePath],
  };
}

function recencySignal(document: RetrievalDocument, now: number): LexicalRetrievalSignalMatch | null {
  if (document.modifiedTime === undefined) return null;
  const ageDays = Math.max(0, (now - document.modifiedTime) / DAY_MS);
  const score = Number((SIGNAL_WEIGHTS.recency / (1 + ageDays)).toFixed(6));
  if (score <= 0) return null;
  return {
    kind: "recency",
    score,
    detail: "recently modified",
    matches: [`${Math.round(ageDays)}d`],
  };
}

function matchedTokens(value: string, queryTokens: readonly string[]): readonly string[] {
  if (queryTokens.length === 0) return [];
  const haystack = value.toLowerCase();
  return queryTokens.filter((token) => haystack.includes(token));
}

function collectSnippets(content: string, queryTokens: readonly string[], maxSnippets: number): readonly string[] {
  if (queryTokens.length === 0 || maxSnippets === 0) return [];
  const snippets: string[] = [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    if (matchedTokens(line, queryTokens).length === 0) continue;
    snippets.push(`${index + 1}: ${line}`);
    if (snippets.length >= maxSnippets) break;
  }
  return snippets;
}

function frontmatterText(document: RetrievalDocument): string {
  const entries = Object.entries(document.frontmatter ?? {});
  return entries
    .map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(" ") : String(value ?? "")}`)
    .join(" ");
}

function graphText(paths: readonly string[] | undefined): string {
  return (paths ?? [])
    .flatMap((path) => [path, path.split("/").pop() ?? path])
    .join(" ");
}

function normalizePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/").toLowerCase();
}

function compareResults(left: LexicalVaultQaResult, right: LexicalVaultQaResult): number {
  if (right.score !== left.score) return right.score - left.score;
  const rightTime = right.document.modifiedTime ?? 0;
  const leftTime = left.document.modifiedTime ?? 0;
  if (rightTime !== leftTime) return rightTime - leftTime;
  return left.document.path.localeCompare(right.document.path);
}
