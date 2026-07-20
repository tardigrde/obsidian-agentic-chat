import type { ToolArtifactMetadata, ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { formatFrontmatterScalar, parseFrontmatterFields } from "./frontmatter";
import { stableTextHash } from "./source-hash";
import {
  chunkSourceText,
  formatSourceArtifactChunkBody,
  legacyTrimmedTextHash,
  normalizeSourcePath,
  normalizeSourceText,
  resolveSourceArtifact,
  type SourceArtifactCacheValue,
  type SourceTextChunk,
} from "./source-ingest";

export const DOCUMENT_IMPORT_CONTENT_TYPE = "text/markdown; charset=utf-8";
export const DOCUMENT_IMPORT_SOURCE_TOOL = "agentic-chat.document-import";

export type DocumentInput = string | ArrayBuffer | Uint8Array;
export type DocumentKind = "epub" | "docx" | "pptx" | "xlsx";
export type DocumentTextExtractor = "epub-zip-lite" | "ooxml-zip-lite";

export interface DocumentExtractionResult {
  text: string;
  kind: DocumentKind;
  extractor: DocumentTextExtractor;
  itemCount: number;
  warnings: string[];
}

export type DocumentTextChunk = SourceTextChunk;

export interface DocumentImportProvenance {
  sourcePath: string;
  title?: string;
  kind: DocumentKind;
  extractor: DocumentTextExtractor;
  importedAt: string;
  dedupKey: string;
  textHash: string;
  sourceTextChars: number;
  itemCount: number;
  chunkCount: number;
}

export interface DocumentImportWriteInput {
  sourcePath: string;
  data: DocumentInput;
  title?: string;
  importedAt?: string;
  maxChunkChars?: number;
}

export interface DocumentImportWriteResult {
  metadata: ToolArtifactMetadata;
  provenance: DocumentImportProvenance;
  artifactCitation: string;
  duplicate: boolean;
  text: string;
  chunks: DocumentTextChunk[];
  extraction: DocumentExtractionResult;
}

type CachedDocumentImport = SourceArtifactCacheValue<DocumentImportProvenance, DocumentExtractionResult>;

interface ZipEntry {
  name: string;
  method: number;
  uncompressedSize: number;
  compressed: Uint8Array;
}

interface ZipInflationBudget {
  remainingTotalBytes: number;
}

export const DOCUMENT_IMPORT_LIMITS = {
  maxArchiveBytes: 50 * 1024 * 1024,
  maxEntries: 4_000,
  maxEntryCompressedBytes: 25 * 1024 * 1024,
  maxEntryUncompressedBytes: 25 * 1024 * 1024,
  maxTotalUncompressedBytes: 100 * 1024 * 1024,
} as const;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

const LEGACY_OFFICE_EXTENSIONS = new Set(["doc", "ppt", "xls"]);
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set<DocumentKind>(["epub", "docx", "pptx", "xlsx"]);

const textDecoder = new TextDecoder("utf-8");

export async function extractDocumentText(input: DocumentInput, sourcePath: string): Promise<DocumentExtractionResult> {
  const kind = documentKindFromPath(sourcePath);
  const entries = await readZipEntries(input);
  const budget = createZipInflationBudget();
  if (kind === "epub") return extractEpubText(entries, budget);
  return extractOfficeOpenXmlText(entries, kind, budget);
}

export function documentKindFromPath(sourcePath: string): DocumentKind {
  const ext = extensionOf(sourcePath);
  if (SUPPORTED_DOCUMENT_EXTENSIONS.has(ext as DocumentKind)) return ext as DocumentKind;
  if (LEGACY_OFFICE_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported Office format: .${ext} is a legacy binary file. Convert it to .${ext}x before import.`);
  }
  throw new Error("Unsupported document format. import_document supports .pdf, .epub, .docx, .pptx, and .xlsx files.");
}

export function chunkDocumentText(text: string, options: { maxChars?: number } = {}): DocumentTextChunk[] {
  return chunkSourceText(text, { maxChars: options.maxChars, anchorPrefix: "document" });
}

export function formatDocumentImportArtifact(
  provenance: DocumentImportProvenance,
  chunks: readonly DocumentTextChunk[],
): string {
  const frontmatter = [
    "---",
    "agentic_chat_document_source: 1",
    `source_path: ${formatFrontmatterScalar(provenance.sourcePath)}`,
    provenance.title ? `title: ${formatFrontmatterScalar(provenance.title)}` : null,
    `kind: ${provenance.kind}`,
    `extractor: ${provenance.extractor}`,
    `imported_at: ${provenance.importedAt}`,
    `dedup_key: ${provenance.dedupKey}`,
    `text_hash: ${provenance.textHash}`,
    `source_text_chars: ${provenance.sourceTextChars}`,
    `item_count: ${provenance.itemCount}`,
    `chunk_count: ${provenance.chunkCount}`,
    "---",
  ].filter((line): line is string => line !== null);
  const header = [
    ...frontmatter,
    "",
    `Source document: ${provenance.sourcePath}`,
    provenance.title ? `Title: ${provenance.title}` : null,
    `Format: ${provenance.kind.toUpperCase()}`,
    "",
    "## Extracted document text",
    "",
  ].filter((line): line is string => line !== null);
  const body = formatSourceArtifactChunkBody(chunks);
  return `${header.join("\n")}${body || "(no extractable text)"}\n`;
}

export function parseDocumentImportProvenance(text: string): DocumentImportProvenance | null {
  const fields = parseFrontmatterFields(text);
  if (!fields) return null;
  if (fields.get("agentic_chat_document_source") !== "1") return null;
  const sourcePath = fields.get("source_path");
  const kind = fields.get("kind");
  const extractor = fields.get("extractor");
  const importedAt = fields.get("imported_at");
  const dedupKey = fields.get("dedup_key");
  const textHash = fields.get("text_hash");
  const sourceTextChars = Number(fields.get("source_text_chars"));
  const itemCount = Number(fields.get("item_count"));
  const chunkCount = Number(fields.get("chunk_count"));
  if (
    !sourcePath ||
    !isDocumentKind(kind) ||
    !isDocumentTextExtractor(extractor) ||
    !importedAt ||
    !dedupKey ||
    !textHash ||
    !Number.isFinite(sourceTextChars) ||
    !Number.isFinite(itemCount) ||
    !Number.isFinite(chunkCount)
  ) {
    return null;
  }
  return {
    sourcePath,
    title: fields.get("title") || undefined,
    kind,
    extractor,
    importedAt,
    dedupKey,
    textHash,
    sourceTextChars,
    itemCount,
    chunkCount,
  };
}

export class DocumentArtifactDeduper {
  private readonly byKey = new Map<string, CachedDocumentImport>();

  async write(store: ToolArtifactStoreLike, input: DocumentImportWriteInput): Promise<DocumentImportWriteResult> {
    const extraction = await extractDocumentText(input.data, input.sourcePath);
    const chunks = chunkDocumentText(extraction.text, { maxChars: input.maxChunkChars });
    const provenance = await createDocumentImportProvenance(input, extraction, chunks);
    return resolveSourceArtifact({
      store,
      cache: this.byKey,
      provenance,
      chunks,
      extraction,
      citationLabel: input.title || input.sourcePath,
      legacyDedupKeys: [legacyDocumentDedupKey(input, extraction)],
      legacyTextHashes: [legacyDocumentTextHash(extraction.text)],
      artifactLabel: documentArtifactLabel(input.title, input.sourcePath, extraction.kind),
      sourceToolName: DOCUMENT_IMPORT_SOURCE_TOOL,
      contentType: DOCUMENT_IMPORT_CONTENT_TYPE,
      sourceKind: provenance.kind,
      formatArtifactText: formatDocumentImportArtifact,
      parseProvenance: parseDocumentImportProvenance,
    });
  }
}

async function createDocumentImportProvenance(
  input: DocumentImportWriteInput,
  extraction: DocumentExtractionResult,
  chunks: readonly DocumentTextChunk[],
): Promise<DocumentImportProvenance> {
  const text = extraction.text.trim();
  const textHash = await stableTextHash(text);
  return {
    sourcePath: input.sourcePath,
    title: input.title,
    kind: extraction.kind,
    extractor: extraction.extractor,
    importedAt: input.importedAt ?? new Date().toISOString(),
    dedupKey: `${extraction.kind}:${normalizeSourcePath(input.sourcePath)}:${textHash}`,
    textHash,
    sourceTextChars: text.length,
    itemCount: extraction.itemCount,
    chunkCount: chunks.length,
  };
}

function legacyDocumentDedupKey(input: DocumentImportWriteInput, extraction: DocumentExtractionResult): string {
  return `${extraction.kind}:${normalizeSourcePath(input.sourcePath)}:${legacyDocumentTextHash(extraction.text)}`;
}

function legacyDocumentTextHash(text: string): string {
  return legacyTrimmedTextHash(text);
}

async function extractEpubText(entries: readonly ZipEntry[], budget: ZipInflationBudget): Promise<DocumentExtractionResult> {
  const htmlEntries = entries
    .filter((entry) => /\.(xhtml|html|htm)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (htmlEntries.length === 0) {
    throw new Error("EPUB contains no readable XHTML/HTML content documents.");
  }
  const parts: string[] = [];
  for (const entry of htmlEntries) {
    const text = htmlToText(await entryText(entry, budget));
    if (text) parts.push(text);
  }
  const text = normalizeSourceText(parts.join("\n\n"));
  if (!text) throw new Error("EPUB contains no extractable text.");
  return {
    text,
    kind: "epub",
    extractor: "epub-zip-lite",
    itemCount: htmlEntries.length,
    warnings: [],
  };
}

async function extractOfficeOpenXmlText(
  entries: readonly ZipEntry[],
  kind: Exclude<DocumentKind, "epub">,
  budget: ZipInflationBudget,
): Promise<DocumentExtractionResult> {
  const parts: string[] = [];
  let itemCount: number;
  if (kind === "docx") {
    const document = entries.find((entry) => entry.name === "word/document.xml");
    if (!document) throw new Error("DOCX is missing word/document.xml.");
    parts.push(extractTextTags(await entryText(document, budget)));
    itemCount = 1;
  } else if (kind === "pptx") {
    const slides = entries
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (slides.length === 0) throw new Error("PPTX contains no slides.");
    for (const slide of slides) parts.push(extractTextTags(await entryText(slide, budget)));
    itemCount = slides.length;
  } else {
    const sharedStrings = entries.find((entry) => entry.name === "xl/sharedStrings.xml");
    if (sharedStrings) parts.push(extractTextTags(await entryText(sharedStrings, budget)));
    const sheets = entries
      .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (sheets.length === 0 && !sharedStrings) throw new Error("XLSX contains no worksheets.");
    for (const sheet of sheets) parts.push(extractSpreadsheetSheetText(await entryText(sheet, budget)));
    itemCount = Math.max(1, sheets.length);
  }
  const text = normalizeSourceText(parts.join("\n\n"));
  if (!text) throw new Error(`${kind.toUpperCase()} contains no extractable text.`);
  return {
    text,
    kind,
    extractor: "ooxml-zip-lite",
    itemCount,
    warnings: [],
  };
}

async function readZipEntries(input: DocumentInput): Promise<ZipEntry[]> {
  const bytes = documentInputToBytes(input);
  if (bytes.byteLength > DOCUMENT_IMPORT_LIMITS.maxArchiveBytes) {
    throw new Error(`Document archive is too large (${bytes.byteLength} bytes). Maximum supported size is ${DOCUMENT_IMPORT_LIMITS.maxArchiveBytes} bytes.`);
  }
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const entryCount = readUint16(bytes, eocdOffset + 10);
  if (entryCount > DOCUMENT_IMPORT_LIMITS.maxEntries) {
    throw new Error(`Document archive contains too many ZIP entries (${entryCount}). Maximum supported entries: ${DOCUMENT_IMPORT_LIMITS.maxEntries}.`);
  }
  const centralOffset = readUint32(bytes, eocdOffset + 16);
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(bytes, offset) !== ZIP_CENTRAL_SIGNATURE) throw new Error("Invalid ZIP central directory.");
    const flags = readUint16(bytes, offset + 8);
    const method = readUint16(bytes, offset + 10);
    const compressedSize = readUint32(bytes, offset + 20);
    const uncompressedSize = readUint32(bytes, offset + 24);
    const localOffset = readUint32(bytes, offset + 42);
    const nameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    if ((flags & 0x01) !== 0) throw new Error("Encrypted ZIP entries are not supported.");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 documents are not supported by the mobile-safe importer.");
    }
    const name = decodeUtf8(bytes.slice(offset + 46, offset + 46 + nameLength));
    if (compressedSize > DOCUMENT_IMPORT_LIMITS.maxEntryCompressedBytes) {
      throw new Error(`ZIP entry is too large before decompression: ${name || "(unnamed)"}.`);
    }
    if (uncompressedSize > DOCUMENT_IMPORT_LIMITS.maxEntryUncompressedBytes) {
      throw new Error(`ZIP entry is too large after decompression: ${name || "(unnamed)"}.`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > DOCUMENT_IMPORT_LIMITS.maxTotalUncompressedBytes) {
      throw new Error("Document archive expands to too much data.");
    }
    const localNameLength = readUint16(bytes, localOffset + 26);
    const localExtraLength = readUint16(bytes, localOffset + 28);
    if (readUint32(bytes, localOffset) !== ZIP_LOCAL_SIGNATURE) throw new Error("Invalid ZIP local file header.");
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.byteLength) throw new Error("Invalid ZIP entry size.");
    entries.push({
      name,
      method,
      uncompressedSize,
      compressed: bytes.slice(dataStart, dataStart + compressedSize),
    });
  }
  return entries;
}

async function entryText(entry: ZipEntry, budget: ZipInflationBudget): Promise<string> {
  return decodeUtf8(await inflateZipEntry(entry, budget));
}

async function inflateZipEntry(entry: ZipEntry, budget: ZipInflationBudget): Promise<Uint8Array> {
  if (entry.method === 0) {
    if (entry.compressed.byteLength !== entry.uncompressedSize) throw new Error(`Invalid ZIP stored entry size: ${entry.name}.`);
    chargeInflatedBytes(entry.compressed.byteLength, budget);
    return entry.compressed;
  }
  if (entry.method !== 8) throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
  const Decompression = window.DecompressionStream;
  if (typeof Decompression !== "function") {
    throw new TypeError("This platform cannot decompress ZIP-based documents; try importing on desktop or update Obsidian.");
  }
  const buffer = new ArrayBuffer(entry.compressed.byteLength);
  new Uint8Array(buffer).set(entry.compressed);
  const stream = new Blob([buffer]).stream().pipeThrough(new Decompression("deflate-raw"));
  return readInflatedStream(stream, entry, budget);
}

async function readInflatedStream(
  stream: ReadableStream<Uint8Array>,
  entry: ZipEntry,
  budget: ZipInflationBudget,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const nextTotal = total + chunk.byteLength;
      if (nextTotal > DOCUMENT_IMPORT_LIMITS.maxEntryUncompressedBytes) {
        await reader.cancel();
        throw new Error(`ZIP entry is too large after decompression: ${entry.name || "(unnamed)"}.`);
      }
      if (chunk.byteLength > budget.remainingTotalBytes) {
        await reader.cancel();
        throw new Error("Document archive expands to too much data.");
      }
      budget.remainingTotalBytes -= chunk.byteLength;
      total = nextTotal;
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== entry.uncompressedSize) throw new Error(`Invalid ZIP inflated entry size: ${entry.name}.`);
  return concatByteChunks(chunks, total);
}

function chargeInflatedBytes(byteLength: number, budget: ZipInflationBudget): void {
  if (byteLength > budget.remainingTotalBytes) throw new Error("Document archive expands to too much data.");
  budget.remainingTotalBytes -= byteLength;
}

function concatByteChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function createZipInflationBudget(): ZipInflationBudget {
  return { remainingTotalBytes: DOCUMENT_IMPORT_LIMITS.maxTotalUncompressedBytes };
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minOffset = Math.max(0, bytes.length - 66_000);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (readUint32(bytes, offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw new Error("Unsupported document: expected a ZIP-based EPUB or Office file.");
}

function htmlToText(input: string): string {
  const doc = new DOMParser().parseFromString(input, "text/html");
  // textContent includes the bodies of <script>/<style>/<noscript>, so drop those
  // elements first — otherwise JS source and CSS leak into the ingested text.
  for (const el of Array.from(doc.querySelectorAll("script, style, noscript"))) {
    el.remove();
  }
  return normalizeSourceText(doc.body.textContent ?? "");
}

function extractTextTags(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const values: string[] = [];
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    if (el.localName === "t") values.push(el.textContent ?? "");
  }
  if (values.length > 0) return normalizeSourceText(values.join("\n"));
  return normalizeSourceText(xml.replace(/<[^<>]+>/g, " "));
}

function extractSpreadsheetSheetText(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const values: string[] = [];
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    if (el.localName === "t" || el.localName === "v") values.push(el.textContent ?? "");
  }
  return normalizeSourceText(values.join("\n"));
}

function documentInputToBytes(input: DocumentInput): Uint8Array {
  if (typeof input === "string") {
    const bytes = new Uint8Array(input.length);
    for (let index = 0; index < input.length; index += 1) bytes[index] = input.charCodeAt(index) & 0xff;
    return bytes;
  }
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function extensionOf(sourcePath: string): string {
  const clean = sourcePath.trim().toLowerCase();
  const index = clean.lastIndexOf(".");
  return index === -1 ? "" : clean.slice(index + 1);
}

function documentArtifactLabel(title: string | undefined, sourcePath: string, kind: DocumentKind): string {
  const label = title?.trim() || sourcePath;
  return `${kind.toUpperCase()}: ${label}`.slice(0, 160);
}

function isDocumentKind(value: unknown): value is DocumentKind {
  return value === "epub" || value === "docx" || value === "pptx" || value === "xlsx";
}

function isDocumentTextExtractor(value: unknown): value is DocumentTextExtractor {
  return value === "epub-zip-lite" || value === "ooxml-zip-lite";
}
