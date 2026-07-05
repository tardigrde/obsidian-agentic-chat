import type { ToolArtifactMetadata, ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { formatSourceReference } from "./citations";
import { formatFrontmatterScalar, parseFrontmatterFields } from "./frontmatter";
import { legacyStableTextHash, stableTextHash } from "./source-hash";
import { findExistingSourceArtifact } from "./source-artifact-dedupe";

export const PDF_IMPORT_CONTENT_TYPE = "text/markdown; charset=utf-8";
export const PDF_IMPORT_SOURCE_TOOL = "agentic-chat.pdf-import";
export const PDF_TEXT_EXTRACTOR = "pdf-text-lite";

export type PdfInput = string | ArrayBuffer | Uint8Array;
export type PdfTextExtractor = typeof PDF_TEXT_EXTRACTOR;

export interface PdfExtractionResult {
  text: string;
  extractor: PdfTextExtractor;
  pageCount: number | null;
  warnings: string[];
}

export interface PdfTextChunk {
  index: number;
  anchor: string;
  start: number;
  end: number;
  text: string;
}

export interface PdfImportProvenance {
  sourcePath: string;
  title?: string;
  extractor: PdfTextExtractor;
  importedAt: string;
  dedupKey: string;
  textHash: string;
  sourceTextChars: number;
  pageCount: number | null;
  chunkCount: number;
}

export interface PdfImportWriteInput {
  sourcePath: string;
  data: PdfInput;
  title?: string;
  importedAt?: string;
  maxChunkChars?: number;
}

export interface PdfImportWriteResult {
  metadata: ToolArtifactMetadata;
  provenance: PdfImportProvenance;
  artifactCitation: string;
  duplicate: boolean;
  text: string;
  chunks: PdfTextChunk[];
  extraction: PdfExtractionResult;
}

interface CachedPdfImport {
  metadata: ToolArtifactMetadata;
  provenance: PdfImportProvenance;
  artifactCitation: string;
  text: string;
  chunks: PdfTextChunk[];
  extraction: PdfExtractionResult;
}

const DEFAULT_MAX_CHUNK_CHARS = 8_000;
const MIN_CHUNK_CHARS = 40;
const PDF_HEADER_SEARCH_CHARS = 1024;

export function extractPdfText(input: PdfInput): PdfExtractionResult {
  const raw = pdfInputToBinaryString(input);
  if (!raw.slice(0, PDF_HEADER_SEARCH_CHARS).includes("%PDF-")) {
    throw new Error("Unsupported file: expected a PDF header.");
  }

  const warnings: string[] = [];
  const literalStrings = extractLiteralStrings(raw).map(decodePdfLiteralString);
  const hexStrings = extractHexStrings(raw).map(decodePdfHexString);
  const text = normalizePdfText([...literalStrings, ...hexStrings].filter(isUsefulPdfText).join("\n"));
  const pageCount = countPdfPages(raw);

  if (!text) {
    throw new Error("PDF contains no extractable text. Scanned/image-only PDFs need OCR before import.");
  }
  if (pageCount === null) warnings.push("Could not determine PDF page count.");

  return {
    text,
    extractor: PDF_TEXT_EXTRACTOR,
    pageCount,
    warnings,
  };
}

export function chunkPdfText(text: string, options: { maxChars?: number } = {}): PdfTextChunk[] {
  const normalized = normalizePdfText(text);
  if (!normalized) return [];
  const maxChars = normalizeMaxChunkChars(options.maxChars);
  const chunks: Array<Omit<PdfTextChunk, "index" | "anchor">> = [];
  let cursor = 0;
  let current = "";
  let currentStart = 0;
  let currentEnd = 0;

  for (const paragraph of normalized.split(/\n{2,}/)) {
    const paragraphStart = normalized.indexOf(paragraph, cursor);
    const safeParagraphStart = paragraphStart === -1 ? cursor : paragraphStart;
    cursor = safeParagraphStart + paragraph.length;

    if (paragraph.length > maxChars) {
      flushCurrent();
      for (let offset = 0; offset < paragraph.length; offset += maxChars) {
        const segment = paragraph.slice(offset, offset + maxChars).trim();
        if (!segment) continue;
        chunks.push({
          start: safeParagraphStart + offset,
          end: safeParagraphStart + offset + segment.length,
          text: segment,
        });
      }
      continue;
    }

    const separator = current ? "\n\n" : "";
    if (current && current.length + separator.length + paragraph.length > maxChars) {
      flushCurrent();
    }
    if (!current) currentStart = safeParagraphStart;
    current = current ? `${current}\n\n${paragraph}` : paragraph;
    currentEnd = safeParagraphStart + paragraph.length;
  }

  flushCurrent();

  return chunks.map((chunk, index) => ({
    ...chunk,
    index: index + 1,
    anchor: `pdf-chunk-${index + 1}`,
  }));

  function flushCurrent(): void {
    const text = current.trim();
    if (!text) return;
    chunks.push({ start: currentStart, end: currentEnd, text });
    current = "";
    currentStart = currentEnd;
  }
}

export function formatPdfImportArtifact(provenance: PdfImportProvenance, chunks: readonly PdfTextChunk[]): string {
  const frontmatter = [
    "---",
    "agentic_chat_pdf_source: 1",
    `source_path: ${formatFrontmatterScalar(provenance.sourcePath)}`,
    provenance.title ? `title: ${formatFrontmatterScalar(provenance.title)}` : null,
    `extractor: ${provenance.extractor}`,
    `imported_at: ${provenance.importedAt}`,
    `dedup_key: ${provenance.dedupKey}`,
    `text_hash: ${provenance.textHash}`,
    `source_text_chars: ${provenance.sourceTextChars}`,
    `page_count: ${provenance.pageCount ?? ""}`,
    `chunk_count: ${provenance.chunkCount}`,
    "---",
  ].filter((line): line is string => line !== null);
  const header = [
    ...frontmatter,
    "",
    `Source PDF: ${provenance.sourcePath}`,
    provenance.title ? `Title: ${provenance.title}` : null,
    "",
    "## Extracted PDF text",
    "",
  ].filter((line): line is string => line !== null);
  const body = chunks
    .map((chunk) => {
      const range = `characters ${chunk.start}-${Math.max(chunk.start, chunk.end - 1)}`;
      return [`### Chunk ${chunk.index}`, `<!-- ${chunk.anchor} ${range} -->`, "", chunk.text, "", `^${chunk.anchor}`].join("\n");
    })
    .join("\n\n");
  return `${header.join("\n")}${body || "(no extractable text)"}\n`;
}

export function parsePdfImportProvenance(text: string): PdfImportProvenance | null {
  const fields = parseFrontmatterFields(text);
  if (!fields) return null;
  if (fields.get("agentic_chat_pdf_source") !== "1") return null;
  const sourcePath = fields.get("source_path");
  const extractor = fields.get("extractor");
  const importedAt = fields.get("imported_at");
  const dedupKey = fields.get("dedup_key");
  const textHash = fields.get("text_hash");
  const sourceTextChars = Number(fields.get("source_text_chars"));
  const pageCountField = fields.get("page_count") ?? "";
  const pageCount = pageCountField ? Number(pageCountField) : null;
  const chunkCount = Number(fields.get("chunk_count"));
  if (
    !sourcePath ||
    extractor !== PDF_TEXT_EXTRACTOR ||
    !importedAt ||
    !dedupKey ||
    !textHash ||
    !Number.isFinite(sourceTextChars) ||
    (pageCount !== null && !Number.isFinite(pageCount)) ||
    !Number.isFinite(chunkCount)
  ) {
    return null;
  }
  return {
    sourcePath,
    title: fields.get("title") || undefined,
    extractor,
    importedAt,
    dedupKey,
    textHash,
    sourceTextChars,
    pageCount,
    chunkCount,
  };
}

export async function writePdfSourceArtifact(
  store: ToolArtifactStoreLike,
  input: PdfImportWriteInput,
): Promise<PdfImportWriteResult> {
  return new PdfArtifactDeduper().write(store, input);
}

export class PdfArtifactDeduper {
  private readonly byKey = new Map<string, CachedPdfImport>();

  async write(store: ToolArtifactStoreLike, input: PdfImportWriteInput): Promise<PdfImportWriteResult> {
    const extraction = extractPdfText(input.data);
    const chunks = chunkPdfText(extraction.text, { maxChars: input.maxChunkChars });
    const provenance = await createPdfImportProvenance(input, extraction, chunks);
    const cached = this.byKey.get(provenance.dedupKey);
    if (cached) return { ...cached, duplicate: true };

    const existing = await findExistingSourceArtifact(store, {
      dedupKey: provenance.dedupKey,
      textHash: provenance.textHash,
      legacyDedupKeys: [legacyPdfDedupKey(input, extraction)],
      legacyTextHashes: [legacyPdfTextHash(extraction.text)],
    });
    if (existing) {
      const artifactCitation = formatSourceReference({
        type: "artifact",
        artifactId: existing.artifact.metadata.id,
        label: input.title || input.sourcePath,
      });
      const persistedProvenance = parsePdfImportProvenance(existing.artifact.text) ?? provenance;
      const value = {
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

    const text = formatPdfImportArtifact(provenance, chunks);
    const metadata = await store.writeArtifact({
      label: pdfArtifactLabel(input.title, input.sourcePath),
      sourceToolName: PDF_IMPORT_SOURCE_TOOL,
      contentType: PDF_IMPORT_CONTENT_TYPE,
      dedupKey: provenance.dedupKey,
      sourceKind: "pdf",
      sourceTextHash: provenance.textHash,
      text,
    });
    const artifactCitation = formatSourceReference({
      type: "artifact",
      artifactId: metadata.id,
      label: input.title || input.sourcePath,
    });
    const value = { metadata, provenance, artifactCitation, text, chunks, extraction };
    this.byKey.set(provenance.dedupKey, value);
    return { ...value, duplicate: false };
  }
}

async function createPdfImportProvenance(
  input: PdfImportWriteInput,
  extraction: PdfExtractionResult,
  chunks: readonly PdfTextChunk[],
): Promise<PdfImportProvenance> {
  const text = extraction.text.trim();
  const textHash = await stableTextHash(text);
  return {
    sourcePath: input.sourcePath,
    title: input.title,
    extractor: extraction.extractor,
    importedAt: input.importedAt ?? new Date().toISOString(),
    dedupKey: `pdf:${normalizeSourcePath(input.sourcePath)}:${textHash}`,
    textHash,
    sourceTextChars: text.length,
    pageCount: extraction.pageCount,
    chunkCount: chunks.length,
  };
}

function legacyPdfDedupKey(input: PdfImportWriteInput, extraction: PdfExtractionResult): string {
  return `pdf:${normalizeSourcePath(input.sourcePath)}:${legacyPdfTextHash(extraction.text)}`;
}

function legacyPdfTextHash(text: string): string {
  return legacyStableTextHash(text.trim());
}

function extractLiteralStrings(input: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== "(") continue;
    let depth = 1;
    let value = "";
    index += 1;
    for (; index < input.length; index += 1) {
      const char = input[index];
      if (char === "\\") {
        value += char;
        index += 1;
        if (index < input.length) value += input[index];
        continue;
      }
      if (char === "(") {
        depth += 1;
        value += char;
        continue;
      }
      if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
        value += char;
        continue;
      }
      value += char;
    }
    if (value) values.push(value);
  }
  return values;
}

function extractHexStrings(input: string): string[] {
  const values: string[] = [];
  const pattern = /<([0-9a-fA-F\s]{4,})>/g;
  for (const match of input.matchAll(pattern)) {
    values.push(match[1]);
  }
  return values;
}

function decodePdfLiteralString(input: string): string {
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char !== "\\") {
      output += char;
      continue;
    }
    const next = input[index + 1];
    if (next === undefined) break;
    if (next === "\r" || next === "\n") {
      index += next === "\r" && input[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    if (/[0-7]/.test(next)) {
      let octal = next;
      let consumed = 1;
      while (consumed < 3 && /[0-7]/.test(input[index + 1 + consumed] ?? "")) {
        octal += input[index + 1 + consumed];
        consumed += 1;
      }
      output += String.fromCharCode(Number.parseInt(octal, 8));
      index += consumed;
      continue;
    }
    const escapes: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      "(": "(",
      ")": ")",
      "\\": "\\",
    };
    output += escapes[next] ?? next;
    index += 1;
  }
  return output;
}

function decodePdfHexString(input: string): string {
  const hex = input.replace(/\s+/g, "");
  let output = "";
  for (let index = 0; index < hex.length; index += 2) {
    const pair = hex.slice(index, index + 2).padEnd(2, "0");
    const value = Number.parseInt(pair, 16);
    if (Number.isFinite(value)) output += String.fromCharCode(value);
  }
  return output;
}

function countPdfPages(input: string): number | null {
  const matches = input.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : null;
}

function isUsefulPdfText(value: string): boolean {
  const normalized = normalizePdfText(value);
  return normalized.length >= 2 && /[A-Za-z0-9]/.test(normalized);
}

function normalizePdfText(input: string): string {
  return input
    .split(String.fromCharCode(0))
    .join("")
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pdfInputToBinaryString(input: PdfInput): string {
  if (typeof input === "string") return input;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let output = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    const chunk = bytes.slice(index, index + 8192);
    output += String.fromCharCode(...chunk);
  }
  return output;
}

function normalizeMaxChunkChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CHUNK_CHARS;
  return Math.max(MIN_CHUNK_CHARS, Math.trunc(value));
}

function normalizeSourcePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function pdfArtifactLabel(title: string | undefined, sourcePath: string): string {
  const label = title?.trim() || sourcePath;
  return `PDF: ${label}`.slice(0, 160);
}
