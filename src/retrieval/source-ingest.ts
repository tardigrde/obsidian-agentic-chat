// The one import flow for source artifacts. The web (`source-artifacts.ts`),
// PDF (`pdf-ingest.ts`), and document (`document-ingest.ts`) importers own
// only extraction and their provenance frontmatter; chunking, dedup keys, the
// per-importer cache, the existing-artifact lookup, and the write live here.

import type { ToolArtifactMetadata, ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { formatSourceReference } from "./citations";
import { legacyStableTextHash, stableTextHash } from "./source-hash";
import { findExistingSourceArtifact } from "./source-artifact-dedupe";

const DEFAULT_MAX_CHUNK_CHARS = 8_000;
const MIN_CHUNK_CHARS = 40;

export interface SourceTextChunk {
  index: number;
  anchor: string;
  start: number;
  end: number;
  text: string;
}

export function normalizeSourceText(input: string): string {
  return input
    .replaceAll("\0", "")
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeMaxChunkChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CHUNK_CHARS;
  return Math.max(MIN_CHUNK_CHARS, Math.trunc(value));
}

export function normalizeSourcePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+/g, "/").toLowerCase();
}

/** Dedup keys of an imported text, current and legacy. */
export interface SourceDedupKeys {
  /** The text the hashes cover. */
  trimmedText: string;
  textHash: string;
  /** `${scope}:${textHash}`. */
  dedupKey: string;
  /** The FNV-1a hash earlier releases wrote; still matched so old artifacts dedupe. */
  legacyTextHash: string;
  legacyDedupKey: string;
}

/**
 * Dedup keys for `text` under `scope` (the importer kind plus the normalized
 * source, such as `pdf:notes/a.pdf`). Every importer derives its keys here, so
 * a persisted artifact from any release keeps deduping.
 */
export async function sourceDedupKeys(scope: string, text: string): Promise<SourceDedupKeys> {
  const trimmedText = text.trim();
  const textHash = await stableTextHash(trimmedText);
  const legacyTextHash = legacyStableTextHash(trimmedText);
  return {
    trimmedText,
    textHash,
    dedupKey: `${scope}:${textHash}`,
    legacyTextHash,
    legacyDedupKey: `${scope}:${legacyTextHash}`,
  };
}

/**
 * Split normalized text into paragraph-aware chunks. Anchors are named
 * `${anchorPrefix}-chunk-N` so different importers keep distinct citation ids.
 */
export function chunkSourceText(text: string, options: { maxChars?: number; anchorPrefix: string }): SourceTextChunk[] {
  const normalized = normalizeSourceText(text);
  if (!normalized) return [];
  const maxChars = normalizeMaxChunkChars(options.maxChars);
  return buildRawChunks(normalized, maxChars).map((chunk, index) => ({
    ...chunk,
    index: index + 1,
    anchor: `${options.anchorPrefix}-chunk-${index + 1}`,
  }));
}

type RawSourceChunk = Omit<SourceTextChunk, "index" | "anchor">;

function buildRawChunks(normalized: string, maxChars: number): RawSourceChunk[] {
  const chunks: RawSourceChunk[] = [];
  let pending: RawSourceChunk | null = null;
  const flush = (): void => {
    const text = pending?.text.trim();
    if (pending && text) chunks.push({ start: pending.start, end: pending.end, text });
    pending = null;
  };

  let cursor = 0;
  for (const paragraph of normalized.split(/\n{2,}/)) {
    const found = normalized.indexOf(paragraph, cursor);
    const start = found === -1 ? cursor : found;
    cursor = start + paragraph.length;

    if (paragraph.length > maxChars) {
      flush();
      chunks.push(...splitLargeParagraph(paragraph, start, maxChars));
      continue;
    }

    if (pending && pending.text.length + 2 + paragraph.length > maxChars) flush();
    pending = pending
      ? { start: pending.start, end: start + paragraph.length, text: `${pending.text}\n\n${paragraph}` }
      : { start, end: start + paragraph.length, text: paragraph };
  }

  flush();
  return chunks;
}

function splitLargeParagraph(paragraph: string, start: number, maxChars: number): RawSourceChunk[] {
  const chunks: RawSourceChunk[] = [];
  for (let offset = 0; offset < paragraph.length; offset += maxChars) {
    const segment = paragraph.slice(offset, offset + maxChars).trim();
    if (segment) chunks.push({ start: start + offset, end: start + offset + segment.length, text: segment });
  }
  return chunks;
}

/** Render the `### Chunk N` body shared by the importer artifact formatters. */
export function formatSourceArtifactChunkBody(chunks: readonly SourceTextChunk[]): string {
  return chunks
    .map((chunk) => {
      const range = `characters ${chunk.start}-${Math.max(chunk.start, chunk.end - 1)}`;
      return [`### Chunk ${chunk.index}`, `<!-- ${chunk.anchor} ${range} -->`, "", chunk.text, "", `^${chunk.anchor}`].join("\n");
    })
    .join("\n\n");
}

export interface SourceArtifactCacheValue<Provenance, Extraction> {
  metadata: ToolArtifactMetadata;
  provenance: Provenance;
  artifactCitation: string;
  text: string;
  chunks: SourceTextChunk[];
  extraction: Extraction;
}

export interface ResolveSourceArtifactConfig<Provenance extends { dedupKey: string; textHash: string }, Extraction> {
  provenance: Provenance;
  chunks: SourceTextChunk[];
  extraction: Extraction;
  /** Human-readable label used for the returned citation. */
  citationLabel: string;
  keys: SourceDedupKeys;
  artifactLabel: string;
  sourceToolName: string;
  contentType: string;
  sourceKind: string;
  formatArtifactText: (provenance: Provenance, chunks: readonly SourceTextChunk[]) => string;
  parseProvenance: (text: string) => Provenance | null;
}

export type ResolvedSourceArtifact<Provenance, Extraction> = SourceArtifactCacheValue<Provenance, Extraction> & {
  duplicate: boolean;
};

/**
 * One importer's artifacts: the in-memory cache by dedup key, the lookup of an
 * artifact an earlier session persisted, and the write. Importers own
 * extraction, chunking, and provenance, and hand the results here to persist
 * or reuse an artifact.
 */
export class SourceArtifactCache<Provenance extends { dedupKey: string; textHash: string }, Extraction> {
  private readonly byKey = new Map<string, SourceArtifactCacheValue<Provenance, Extraction>>();

  async resolve(
    store: ToolArtifactStoreLike,
    config: ResolveSourceArtifactConfig<Provenance, Extraction>,
  ): Promise<ResolvedSourceArtifact<Provenance, Extraction>> {
    const { provenance, chunks, extraction, citationLabel } = config;

    const cached = this.byKey.get(provenance.dedupKey);
    if (cached) return { ...cached, duplicate: true };

    const existing = await findExistingSourceArtifact(store, {
      dedupKey: provenance.dedupKey,
      textHash: provenance.textHash,
      legacyDedupKeys: [config.keys.legacyDedupKey],
      legacyTextHashes: [config.keys.legacyTextHash],
    });
    if (existing) {
      const artifactCitation = formatSourceReference({
        type: "artifact",
        artifactId: existing.artifact.metadata.id,
        label: citationLabel,
      });
      const persistedProvenance = config.parseProvenance(existing.artifact.text) ?? provenance;
      const value: SourceArtifactCacheValue<Provenance, Extraction> = {
        metadata: existing.artifact.metadata,
        provenance: persistedProvenance,
        artifactCitation,
        text: existing.artifact.text,
        chunks,
        extraction,
      };
      this.byKey.set(provenance.dedupKey, value);
      return { ...value, duplicate: true };
    }

    const text = config.formatArtifactText(provenance, chunks);
    const metadata = await store.writeArtifact({
      label: config.artifactLabel,
      sourceToolName: config.sourceToolName,
      contentType: config.contentType,
      dedupKey: provenance.dedupKey,
      sourceKind: config.sourceKind,
      sourceTextHash: provenance.textHash,
      text,
    });
    const artifactCitation = formatSourceReference({
      type: "artifact",
      artifactId: metadata.id,
      label: citationLabel,
    });
    const value: SourceArtifactCacheValue<Provenance, Extraction> = {
      metadata,
      provenance,
      artifactCitation,
      text,
      chunks,
      extraction,
    };
    this.byKey.set(provenance.dedupKey, value);
    return { ...value, duplicate: false };
  }
}
