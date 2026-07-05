import type { DataAdapter } from "obsidian";
import {
  formatSourceReference,
  parseSourceReference,
  sourceReferenceKey,
  type SourceReference,
} from "../retrieval/citations";
import { tokenizeRetrievalQuery } from "../retrieval/lexical";

export type MemoryKind = "preference" | "fact" | "instruction" | "summary";
export type MemoryScope = "global" | "vault" | "project";

export interface MemoryProvenanceEntry {
  source: string;
  extractedAt?: string;
  note?: string;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  text: string;
  scope: MemoryScope;
  source?: string;
  provenance?: readonly MemoryProvenanceEntry[];
  supersedes?: readonly string[];
  stale?: boolean;
  forgottenAt?: string;
  forgetReason?: string;
  tags?: readonly string[];
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
  confidence?: number;
}

export interface MemorySearchQuery {
  query: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  maxResults?: number;
}

export interface MemorySearchOptions {
  records: readonly MemoryRecord[];
  allowedScopes?: readonly MemoryScope[];
  includeDisabled?: boolean;
  defaultMaxResults?: number;
}

export interface MemorySearchMatch {
  record: MemoryRecord;
  score: number;
  matchedTokens: readonly string[];
  citation?: SourceReference;
}

export interface MemorySearchResponse {
  queryTokens: readonly string[];
  matches: readonly MemorySearchMatch[];
  totalMatches: number;
  filteredCount: number;
  disabledCount: number;
}

const DEFAULT_ALLOWED_SCOPES: readonly MemoryScope[] = ["global", "vault"];
const DEFAULT_MAX_RESULTS = 8;
const MEMORY_KINDS = new Set<MemoryKind>(["preference", "fact", "instruction", "summary"]);
const MEMORY_SCOPES = new Set<MemoryScope>(["global", "vault", "project"]);

export async function loadMemoryRecords(adapter: DataAdapter | undefined, path: string): Promise<MemoryRecord[]> {
  if (!adapter || !(await adapter.exists(path))) return [];
  return parseMemoryRecords(await adapter.read(path));
}

export function parseMemoryRecords(jsonl: string): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = parseMemoryRecord(JSON.parse(line));
      if (parsed) records.push(parsed);
    } catch {
      continue;
    }
  }
  return dedupeMemoryRecords(records);
}

export function searchMemories(query: MemorySearchQuery, options: MemorySearchOptions): MemorySearchResponse {
  const queryTokens = tokenizeRetrievalQuery(query.query);
  const maxResults = Math.max(1, Math.trunc(query.maxResults ?? options.defaultMaxResults ?? DEFAULT_MAX_RESULTS));
  const allowedScopes = new Set(options.allowedScopes ?? DEFAULT_ALLOWED_SCOPES);
  const matches: MemorySearchMatch[] = [];
  let filteredCount = 0;
  let disabledCount = 0;

  for (const record of options.records) {
    if (record.enabled === false && !options.includeDisabled) {
      disabledCount += 1;
      continue;
    }
    if (!allowedScopes.has(record.scope) || (query.scope && record.scope !== query.scope) || (query.kind && record.kind !== query.kind)) {
      filteredCount += 1;
      continue;
    }
    const match = scoreMemory(record, queryTokens);
    if (match) matches.push(match);
  }

  matches.sort(compareMemoryMatches);
  return {
    queryTokens,
    matches: matches.slice(0, maxResults),
    totalMatches: matches.length,
    filteredCount,
    disabledCount,
  };
}

export function formatMemorySearchResponse(query: MemorySearchQuery, response: MemorySearchResponse): string {
  const lines = [
    `Memory search: ${query.query}`,
    `Matches: ${response.matches.length} of ${response.totalMatches}`,
    `Filtered: ${response.filteredCount}; disabled: ${response.disabledCount}`,
    "",
  ];
  if (response.matches.length === 0) {
    lines.push("No matching stored memories. Memory is only searched when search_memory is called.");
    return lines.join("\n");
  }
  response.matches.forEach((match, index) => {
    const record = match.record;
    lines.push(`${index + 1}. ${record.kind} (${record.scope}) [${record.id}]`);
    lines.push(`   ${record.text}`);
    if (record.tags?.length) lines.push(`   Tags: ${record.tags.join(", ")}`);
    if (match.citation) lines.push(`   Citation: ${formatSourceReference(match.citation)}`);
    lines.push(`   Matched: ${match.matchedTokens.join(", ")}; score ${match.score.toFixed(3)}`);
  });
  return lines.join("\n");
}

export function memoryCitations(matches: readonly MemorySearchMatch[]): string[] {
  const seen = new Set<string>();
  const citations: string[] = [];
  for (const match of matches) {
    if (!match.citation) continue;
    const key = sourceReferenceKey(match.citation);
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push(formatSourceReference(match.citation));
  }
  return citations;
}

function parseMemoryRecord(value: unknown): MemoryRecord | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const id = stringField(input.id);
  const text = stringField(input.text);
  const kind = memoryKind(input.kind);
  if (!id || !text || !kind) return null;
  return {
    id,
    kind,
    text,
    scope: memoryScope(input.scope) ?? "vault",
    source: stringField(input.source),
    provenance: provenanceArray(input.provenance),
    supersedes: stringArray(input.supersedes),
    stale: typeof input.stale === "boolean" ? input.stale : undefined,
    forgottenAt: stringField(input.forgottenAt),
    forgetReason: stringField(input.forgetReason),
    tags: stringArray(input.tags),
    enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
    createdAt: stringField(input.createdAt),
    updatedAt: stringField(input.updatedAt),
    confidence: numberField(input.confidence),
  };
}

function dedupeMemoryRecords(records: readonly MemoryRecord[]): MemoryRecord[] {
  const byId = new Map<string, MemoryRecord>();
  for (const record of records) byId.set(record.id, record);
  return [...byId.values()];
}

function scoreMemory(record: MemoryRecord, queryTokens: readonly string[]): MemorySearchMatch | null {
  if (queryTokens.length === 0) return null;
  const fields = [
    { weight: 1.5, text: record.text },
    { weight: 1.1, text: record.tags?.join(" ") ?? "" },
    { weight: 0.8, text: record.kind },
    { weight: 0.5, text: record.source ?? "" },
  ];
  const matched = new Set<string>();
  let score = 0;
  for (const field of fields) {
    const haystack = field.text.toLowerCase();
    for (const token of queryTokens) {
      if (!haystack.includes(token)) continue;
      matched.add(token);
      score += field.weight;
    }
  }
  if (matched.size === 0) return null;
  const recency = record.updatedAt ?? record.createdAt;
  if (recency) score += recencyBoost(recency);
  if (record.confidence !== undefined) score += Math.max(0, Math.min(1, record.confidence)) * 0.25;
  return {
    record,
    score: Number(score.toFixed(6)),
    matchedTokens: [...matched],
    citation: record.source ? parseSourceReference(record.source) ?? undefined : undefined,
  };
}

function recencyBoost(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  return 0.2 / (1 + ageDays);
}

function compareMemoryMatches(left: MemorySearchMatch, right: MemorySearchMatch): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.record.id.localeCompare(right.record.id);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return strings.length > 0 ? strings : undefined;
}

function provenanceArray(value: unknown): readonly MemoryProvenanceEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((item): MemoryProvenanceEntry | null => {
      if (!item || typeof item !== "object") return null;
      const input = item as Record<string, unknown>;
      const source = stringField(input.source);
      if (!source) return null;
      return {
        source,
        extractedAt: stringField(input.extractedAt),
        note: stringField(input.note),
      };
    })
    .filter((item): item is MemoryProvenanceEntry => item !== null);
  return entries.length > 0 ? entries : undefined;
}

function memoryKind(value: unknown): MemoryKind | null {
  return typeof value === "string" && MEMORY_KINDS.has(value as MemoryKind) ? (value as MemoryKind) : null;
}

function memoryScope(value: unknown): MemoryScope | null {
  return typeof value === "string" && MEMORY_SCOPES.has(value as MemoryScope) ? (value as MemoryScope) : null;
}
