import type { ToolArtifactMetadata, ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { formatFrontmatterScalar, parseFrontmatterFields } from "../vault/frontmatter";
import {
  SourceArtifactCache,
  chunkSourceText,
  formatSourceArtifactChunkBody,
  normalizeSourcePath,
  normalizeSourceText,
  sourceDedupKeys,
  type SourceTextChunk,
} from "./source-ingest";

export const PDF_IMPORT_CONTENT_TYPE = "text/markdown; charset=utf-8";
export const PDF_IMPORT_SOURCE_TOOL = "agentic-chat.pdf-import";
export const PDF_TEXT_EXTRACTOR = "pdfjs";

/** Refuse PDFs larger than this; a 100 MB scan is not a note source (U4 #10). */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** On mobile pdf.js inflates streams in a small heap: a lower cap keeps a compressed PDF from exhausting it. */
export const MAX_PDF_BYTES_MOBILE = 20 * 1024 * 1024;
/** Keep at most this much extracted text; the rest is dropped with a warning. */
export const MAX_PDF_TEXT_CHARS = 1_500_000;
/** Pages read at most: empty pages add no text, so the text cap alone never stops them. */
export const MAX_PDF_PAGES = 2_000;
/** Refuse text where fewer than this share of characters are readable (broken font encodings). */
export const MIN_READABLE_RATIO = 0.85;

export type PdfInput = ArrayBuffer | Uint8Array;

/** The part of pdf.js this importer uses: Obsidian's `loadPdfJs()` or `pdfjs-dist` in tests. */
export interface PdfJsLike {
  getDocument(source: { data: Uint8Array; isEvalSupported?: boolean; disableFontFace?: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }> }>;
      destroy?: () => Promise<void> | void;
    }>;
  };
}

export type PdfJsLoader = () => Promise<PdfJsLike>;
export type PdfTextExtractor = typeof PDF_TEXT_EXTRACTOR;

export interface PdfExtractionResult {
  text: string;
  extractor: PdfTextExtractor;
  pageCount: number | null;
  warnings: string[];
}

export type PdfTextChunk = SourceTextChunk;

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
  signal?: AbortSignal;
  maxBytes?: number;
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

/**
 * Extract the text of a PDF with pdf.js (the copy Obsidian ships). The old
 * scraper read every string in the raw bytes and could not inflate
 * FlateDecode streams: a 105-page PDF became 56 million characters of noise
 * (U4 #10). A file too large is refused; text that is mostly unreadable (a
 * broken font encoding) is refused rather than stored.
 */
export interface PdfExtractOptions {
  /** Stop between pages; a Stop must not leave pdf.js running (U4L). */
  signal?: AbortSignal;
  /** Byte cap; defaults to `MAX_PDF_BYTES` (`MAX_PDF_BYTES_MOBILE` on mobile). */
  maxBytes?: number;
}

export function pdfTooLargeError(byteLength: number, maxBytes: number): Error {
  return new Error(`PDF is too large to import (${Math.round(byteLength / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB).`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("PDF import stopped.");
}

export async function extractPdfText(input: PdfInput, loadPdfJs: PdfJsLoader, options: PdfExtractOptions = {}): Promise<PdfExtractionResult> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const maxBytes = options.maxBytes ?? MAX_PDF_BYTES;
  if (bytes.byteLength > maxBytes) throw pdfTooLargeError(bytes.byteLength, maxBytes);
  throwIfAborted(options.signal);
  if (!new TextDecoder("latin1").decode(bytes.slice(0, 1024)).includes("%PDF-")) {
    throw new Error("Unsupported file: expected a PDF header.");
  }
  const pdfjs = await loadPdfJs();
  throwIfAborted(options.signal);
  // pdf.js may detach the buffer it gets: hand it a copy.
  let document: Awaited<ReturnType<PdfJsLike["getDocument"]>["promise"]>;
  try {
    document = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true }).promise;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "PasswordException") {
      throw new Error("PDF is password-protected. Export a copy without a password, then import that.", { cause: error });
    }
    throw error;
  }
  const warnings: string[] = [];
  const pages: string[] = [];
  let total = 0;
  try {
    const lastPage = Math.min(document.numPages, MAX_PDF_PAGES);
    if (document.numPages > MAX_PDF_PAGES) {
      warnings.push(`Read the first ${MAX_PDF_PAGES.toLocaleString("en-US")} of ${document.numPages.toLocaleString("en-US")} pages.`);
    }
    for (let pageNumber = 1; pageNumber <= lastPage; pageNumber += 1) {
      throwIfAborted(options.signal);
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => `${item.str ?? ""}${item.hasEOL ? "\n" : ""}`).join("");
      pages.push(text);
      total += text.length;
      if (total > MAX_PDF_TEXT_CHARS) {
        warnings.push(`Text cut after page ${pageNumber} of ${document.numPages} (over ${MAX_PDF_TEXT_CHARS.toLocaleString("en-US")} characters).`);
        break;
      }
    }
  } finally {
    await document.destroy?.();
  }
  // A Stop during the last page must not write the artifact.
  throwIfAborted(options.signal);
  let text = normalizeSourceText(pages.join("\n\n"));
  if (text.length > MAX_PDF_TEXT_CHARS) text = text.slice(0, MAX_PDF_TEXT_CHARS);
  if (!text) {
    throw new Error("PDF contains no extractable text. Scanned/image-only PDFs need OCR before import.");
  }
  const readable = readableRatio(text);
  if (readable < MIN_READABLE_RATIO) {
    throw new Error(
      `PDF text looks unreadable (${Math.round(readable * 100)}% readable characters; the fonts may use a custom encoding). Not imported; it needs OCR.`,
    );
  }
  return { text, extractor: PDF_TEXT_EXTRACTOR, pageCount: document.numPages, warnings };
}

/** Share of letters (with combining marks), digits, punctuation, symbols, and spaces (not control or replacement characters). */
export function readableRatio(text: string): number {
  if (!text) return 0;
  const readable = text.match(/[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\n\t]/gu)?.length ?? 0;
  const replacement = text.match(/\uFFFD/gu)?.length ?? 0;
  return Math.max(0, readable - replacement) / text.length;
}

export function chunkPdfText(text: string, options: { maxChars?: number } = {}): PdfTextChunk[] {
  return chunkSourceText(text, { maxChars: options.maxChars, anchorPrefix: "pdf" });
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
  const body = formatSourceArtifactChunkBody(chunks);
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

export class PdfArtifactDeduper {
  private readonly artifacts = new SourceArtifactCache<PdfImportProvenance, PdfExtractionResult>();

  /** `loadPdfJs`: Obsidian's `loadPdfJs` in the app; pdfjs-dist in tests. */
  constructor(private readonly loadPdfJs: PdfJsLoader) {}

  async write(store: ToolArtifactStoreLike, input: PdfImportWriteInput): Promise<PdfImportWriteResult> {
    const extraction = await extractPdfText(input.data, this.loadPdfJs, { signal: input.signal, maxBytes: input.maxBytes });
    const chunks = chunkPdfText(extraction.text, { maxChars: input.maxChunkChars });
    const keys = await sourceDedupKeys(`pdf:${normalizeSourcePath(input.sourcePath)}`, extraction.text);
    const provenance: PdfImportProvenance = {
      sourcePath: input.sourcePath,
      title: input.title,
      extractor: extraction.extractor,
      importedAt: input.importedAt ?? new Date().toISOString(),
      dedupKey: keys.dedupKey,
      textHash: keys.textHash,
      sourceTextChars: keys.trimmedText.length,
      pageCount: extraction.pageCount,
      chunkCount: chunks.length,
    };
    return this.artifacts.resolve(store, {
      provenance,
      chunks,
      extraction,
      citationLabel: input.title || input.sourcePath,
      keys,
      artifactLabel: pdfArtifactLabel(input.title, input.sourcePath),
      sourceToolName: PDF_IMPORT_SOURCE_TOOL,
      contentType: PDF_IMPORT_CONTENT_TYPE,
      sourceKind: "pdf",
      formatArtifactText: formatPdfImportArtifact,
      parseProvenance: parsePdfImportProvenance,
    });
  }
}

function pdfArtifactLabel(title: string | undefined, sourcePath: string): string {
  const label = title?.trim() || sourcePath;
  return `PDF: ${label}`.slice(0, 160);
}
