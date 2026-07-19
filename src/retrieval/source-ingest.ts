// Shared building blocks for the PDF and document (EPUB/OOXML) importers
// (src/retrieval/pdf-ingest.ts and src/retrieval/document-ingest.ts). Both
// importers extract text, chunk it identically, and dedupe/persist the result
// through the tool artifact store; this module holds the pieces that would
// otherwise be copied between them.

import type { ToolArtifactMetadata, ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { formatSourceReference } from "./citations";
import { legacyStableTextHash } from "./source-hash";
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

export function legacyTrimmedTextHash(text: string): string {
  return legacyStableTextHash(text.trim());
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
  store: ToolArtifactStoreLike;
  cache: Map<string, SourceArtifactCacheValue<Provenance, Extraction>>;
  provenance: Provenance;
  chunks: SourceTextChunk[];
  extraction: Extraction;
  /** Human-readable label used for the returned citation. */
  citationLabel: string;
  legacyDedupKeys: string[];
  legacyTextHashes: string[];
  artifactLabel: string;
  sourceToolName: string;
  contentType: string;
  sourceKind: string;
  formatArtifactText: (provenance: Provenance, chunks: readonly SourceTextChunk[]) => string;
  parseProvenance: (text: string) => Provenance | null;
}

/**
 * Shared cache lookup + existing-artifact dedupe + write path for source
 * importers. Callers own extraction, chunking and provenance construction and
 * hand the results here to persist or reuse an artifact.
 */
export async function resolveSourceArtifact<Provenance extends { dedupKey: string; textHash: string }, Extraction>(
  config: ResolveSourceArtifactConfig<Provenance, Extraction>,
): Promise<SourceArtifactCacheValue<Provenance, Extraction> & { duplicate: boolean }> {
  const { store, cache, provenance, chunks, extraction, citationLabel } = config;

  const cached = cache.get(provenance.dedupKey);
  if (cached) return { ...cached, duplicate: true };

  const existing = await findExistingSourceArtifact(store, {
    dedupKey: provenance.dedupKey,
    textHash: provenance.textHash,
    legacyDedupKeys: config.legacyDedupKeys,
    legacyTextHashes: config.legacyTextHashes,
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
    cache.set(provenance.dedupKey, value);
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
  cache.set(provenance.dedupKey, value);
  return { ...value, duplicate: false };
}
