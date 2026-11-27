import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { ToolArtifactMetadata, ToolArtifactStoreLike, ToolArtifactWriteInput } from "../src/artifacts/tool-artifact-store";
import { createDocumentTools } from "../src/tools/document-tools";
import { legacyStableTextHash } from "../src/retrieval/source-hash";
import {
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  PDF_IMPORT_CONTENT_TYPE,
  PDF_IMPORT_SOURCE_TOOL,
  PdfArtifactDeduper,
  chunkPdfText,
  extractPdfText,
  formatPdfImportArtifact,
  readableRatio,
  type PdfJsLike,
} from "../src/retrieval/pdf-ingest";
import { FakeAdapter as MemoryAdapter } from "./support/fake-adapter";

const FIXED_IMPORTED_AT = "2026-06-26T08:00:00.000Z";

/** The real pdf.js (the same library Obsidian ships), from pdfjs-dist. */
const loadPdf = async (): Promise<PdfJsLike> => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsLike;

function escapePdfText(line: string): string {
  return line.replace(/[\\()]/g, (char) => `\\${char}`);
}

/**
 * A valid PDF with one page per entry, each line drawn with Helvetica. With
 * `compress`, every content stream is FlateDecode, as nearly every real PDF
 * is: the old byte scraper could not read those (U4 #10).
 */
function buildPdf(pages: string[][], options: { compress?: boolean } = {}): Uint8Array {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: string | Buffer): void => {
    const buffer = typeof data === "string" ? Buffer.from(data, "latin1") : data;
    chunks.push(buffer);
    length += buffer.length;
  };
  const object = (id: number, body: string | Buffer[]): void => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    if (typeof body === "string") push(body);
    else for (const part of body) push(part);
    push("\nendobj\n");
  };
  push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  const pageIds = pages.map((_, index) => 4 + index * 2);
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((lines, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    const text = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((line) => `(${escapePdfText(line)}) Tj T*`).join(" ")} ET`;
    const raw = Buffer.from(text, "latin1");
    const stream = options.compress ? deflateSync(raw) : raw;
    object(contentId, [
      Buffer.from(`<< /Length ${stream.length}${options.compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`, "latin1"),
      stream,
      Buffer.from("\nendstream", "latin1"),
    ]);
  });
  const size = pageIds.at(-1)! + 2;
  const xref = length;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let id = 1; id < size; id += 1) push(`${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

const LINES = [
  "Q/A and RAG can use lexical retrieval before embeddings.",
  "Multilingual notes need language-aware token normalization.",
  "Embeddings are optional infrastructure.",
];
const PDF_FIXTURE = buildPdf([LINES]);
const PDF_FLATE = buildPdf([["Compressed streams are the common case."], ["Page two of the compressed file."]], { compress: true });

/** Latin-1 string of the bytes, for the text-only memory adapter. */
function latin1(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function memoryArtifactStore(): { store: ToolArtifactStoreLike; writes: ToolArtifactWriteInput[] } {
  const writes: ToolArtifactWriteInput[] = [];
  const artifacts = new Map<string, { metadata: ToolArtifactMetadata; text: string }>();
  return {
    writes,
    store: {
      async writeArtifact(input) {
        writes.push(input);
        const metadata: ToolArtifactMetadata = {
          id: `artifact-${writes.length}`,
          label: input.label,
          sourceToolName: input.sourceToolName,
          contentType: input.contentType ?? "text/plain",
          createdAt: FIXED_IMPORTED_AT,
          charLength: input.text.length,
          dedupKey: input.dedupKey,
          sourceUrl: input.sourceUrl,
          sourceKind: input.sourceKind,
          sourceTextHash: input.sourceTextHash,
        };
        artifacts.set(metadata.id, { metadata, text: input.text });
        return metadata;
      },
      async readArtifact(id) {
        const artifact = artifacts.get(id);
        if (!artifact) throw new Error("not found");
        return artifact;
      },
      async findArtifactByDedupKey(dedupKey) {
        return [...artifacts.values()].find((artifact) => artifact.metadata.dedupKey === dedupKey) ?? null;
      },
      async findArtifactBySourceTextHash(sourceTextHash) {
        return [...artifacts.values()].find((artifact) => artifact.metadata.sourceTextHash === sourceTextHash) ?? null;
      },
    },
  };
}

describe("PDF source ingestion (pdf.js, U4 #10)", () => {
  it("extracts the text of a FlateDecode PDF, page by page", async () => {
    const extracted = await extractPdfText(PDF_FLATE, loadPdf);
    expect(extracted.extractor).toBe("pdfjs");
    expect(extracted.pageCount).toBe(2);
    expect(extracted.text).toContain("Compressed streams are the common case.");
    expect(extracted.text).toContain("Page two of the compressed file.");
    // Nothing but the drawn text: no raw stream bytes.
    expect(extracted.text.length).toBeLessThan(120);
  });

  it("extracts text from an uncompressed PDF", async () => {
    const extracted = await extractPdfText(PDF_FIXTURE, loadPdf);
    expect(extracted.pageCount).toBe(1);
    for (const line of LINES) expect(extracted.text).toContain(line);
  });

  it("refuses unreadable text (a broken font encoding) instead of storing garbage", async () => {
    const garbage = "\u0001\u0002\u0003\uFFFD\uFFFD\u0004\u0005\u0006\u0007\u0008abc";
    expect(readableRatio(garbage)).toBeLessThan(0.85);
    const fake: PdfJsLike = {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({ getTextContent: async () => ({ items: [{ str: garbage.repeat(20) }] }) }),
        }),
      }),
    };
    await expect(extractPdfText(PDF_FIXTURE, async () => fake)).rejects.toThrow(/looks unreadable/);
  });

  it("refuses a PDF over the size cap before parsing it", async () => {
    let loaded = false;
    const big = new Uint8Array(MAX_PDF_BYTES + 1);
    big.set(Buffer.from("%PDF-1.7", "latin1"));
    await expect(
      extractPdfText(big, async () => {
        loaded = true;
        return {} as PdfJsLike;
      }),
    ).rejects.toThrow(/too large to import/);
    expect(loaded).toBe(false);
  });

  it("chunks extracted PDF text into durable citation anchors", async () => {
    const chunks = chunkPdfText((await extractPdfText(PDF_FIXTURE, loadPdf)).text, { maxChars: 48 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.anchor)).toEqual(chunks.map((_, index) => `pdf-chunk-${index + 1}`));
    expect(chunks.every((chunk) => chunk.text.length <= 48)).toBe(true);
  });

  it("deduplicates repeated PDF imports by source path and extracted text", async () => {
    const { store, writes } = memoryArtifactStore();
    const deduper = new PdfArtifactDeduper(loadPdf);

    const first = await deduper.write(store, {
      sourcePath: "Research/Embeddings.pdf",
      title: "Embedding tradeoffs",
      data: PDF_FIXTURE,
      importedAt: FIXED_IMPORTED_AT,
    });
    const second = await deduper.write(store, {
      sourcePath: "Research/embeddings.pdf",
      title: "Embedding tradeoffs",
      data: PDF_FIXTURE,
      importedAt: "2026-06-26T09:00:00.000Z",
    });

    expect(writes).toHaveLength(1);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.metadata.id).toBe(first.metadata.id);
    expect(second.provenance.dedupKey).toBe(first.provenance.dedupKey);
  });

  it("reuses PDF artifacts written with the legacy FNV text hash", async () => {
    const { store, writes } = memoryArtifactStore();
    const sourcePath = "research/legacy.pdf";
    const extracted = await extractPdfText(PDF_FIXTURE, loadPdf);
    const sourceText = extracted.text.trim();
    const textHash = legacyStableTextHash(sourceText);
    const chunks = chunkPdfText(sourceText, { maxChars: 64 });
    const provenance = {
      sourcePath,
      title: "Legacy PDF",
      extractor: "pdfjs" as const,
      importedAt: FIXED_IMPORTED_AT,
      dedupKey: `pdf:${sourcePath}:${textHash}`,
      textHash,
      sourceTextChars: sourceText.length,
      pageCount: extracted.pageCount,
      chunkCount: chunks.length,
    };
    await store.writeArtifact({
      label: "Legacy PDF",
      sourceToolName: PDF_IMPORT_SOURCE_TOOL,
      contentType: PDF_IMPORT_CONTENT_TYPE,
      dedupKey: provenance.dedupKey,
      sourceKind: "pdf",
      sourceTextHash: textHash,
      text: formatPdfImportArtifact(provenance, chunks),
    });

    const duplicate = await new PdfArtifactDeduper(loadPdf).write(store, {
      sourcePath,
      title: "Legacy PDF",
      data: PDF_FIXTURE,
      importedAt: "2026-06-26T09:00:00.000Z",
    });

    expect(writes).toHaveLength(1);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.metadata.id).toBe("artifact-1");
  });

  it("rejects unsupported files and image-only PDFs without hidden fallback text", async () => {
    await expect(extractPdfText(Buffer.from("not a pdf"), loadPdf)).rejects.toThrow(/expected a PDF header/i);
    await expect(extractPdfText(buildPdf([[]]), loadPdf)).rejects.toThrow(/no extractable text/i);
  });

  it("imports a vault PDF through the agent document tool without stuffing full text into the response", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("Research/embeddings.pdf", latin1(PDF_FLATE));
    const { store, writes } = memoryArtifactStore();
    const [tool] = createDocumentTools({ vault: { adapter: adapter.asDataAdapter() } } as unknown as App, store, loadPdf);

    const result = await tool.execute("call-1", {
      path: "Research/embeddings.pdf",
      title: "Compressed",
      maxChunkChars: 64,
    });
    const firstContent = result.content[0];

    expect(firstContent.type).toBe("text");
    if (firstContent.type !== "text") throw new Error("Expected text tool content.");
    expect(firstContent.text).toContain("PDF source artifact: [Compressed](artifact:artifact-1)");
    expect(firstContent.text).not.toContain("Compressed streams are the common case");
    expect(writes).toHaveLength(1);
    expect(result.details).toMatchObject({
      path: "Research/embeddings.pdf",
      sourceArtifactId: "artifact-1",
      sourceArtifactDuplicate: false,
      extractor: "pdfjs",
      pageCount: 2,
    });
  });

  it("rejects unsupported vault paths before reading the file", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("Research/source.txt", "not a pdf");
    const { store } = memoryArtifactStore();
    const [tool] = createDocumentTools({ vault: { adapter: adapter.asDataAdapter() } } as unknown as App, store, loadPdf);

    await expect(tool.execute("call-1", { path: "Research/source.txt" })).rejects.toThrow(/Unsupported document format/);
  });

  it("refuses a too-large PDF by its stat size before reading the file (B1)", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("Research/huge.pdf", latin1(PDF_FLATE));
    const data = adapter.asDataAdapter();
    let reads = 0;
    const sized = {
      ...data,
      stat: async () => ({ type: "file", ctime: 0, mtime: 0, size: MAX_PDF_BYTES + 1 }),
      readBinary: async (path: string) => {
        reads += 1;
        return data.readBinary(path);
      },
      read: async (path: string) => {
        reads += 1;
        return data.read(path);
      },
    };
    const { store } = memoryArtifactStore();
    const [tool] = createDocumentTools({ vault: { adapter: sized } } as unknown as App, store, loadPdf);

    await expect(tool.execute("call-1", { path: "Research/huge.pdf" })).rejects.toThrow(/too large to import/);
    expect(reads).toBe(0);
  });

  it("stops the import when the tool signal is aborted (B1)", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("Research/embeddings.pdf", latin1(PDF_FLATE));
    const { store, writes } = memoryArtifactStore();
    const [tool] = createDocumentTools({ vault: { adapter: adapter.asDataAdapter() } } as unknown as App, store, loadPdf);
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute("call-1", { path: "Research/embeddings.pdf" }, controller.signal)).rejects.toThrow(/stopped/);
    expect(writes).toHaveLength(0);
  });

  it("stops between pages when the signal aborts mid-extraction (B1)", async () => {
    const controller = new AbortController();
    let pagesRead = 0;
    const pdfjs = async (): Promise<PdfJsLike> => {
      const real = await loadPdf();
      return {
        getDocument: (source) => {
          const task = real.getDocument(source);
          return {
            promise: task.promise.then((document) => ({
              ...document,
              numPages: document.numPages,
              getPage: async (pageNumber: number) => {
                pagesRead += 1;
                controller.abort();
                return document.getPage(pageNumber);
              },
              destroy: () => document.destroy?.(),
            })),
          };
        },
      };
    };

    await expect(extractPdfText(buildPdf([["one"], ["two"], ["three"]]), pdfjs, { signal: controller.signal })).rejects.toThrow(/stopped/);
    expect(pagesRead).toBe(1);
  });

  it("applies a lower byte cap when one is passed (mobile)", async () => {
    await expect(extractPdfText(buildPdf([["small"]]), loadPdf, { maxBytes: 10 })).rejects.toThrow(/too large to import/);
  });
});

describe("PDF hardening (U4-B review)", () => {
  const pdfHeader = new TextEncoder().encode("%PDF-1.7\n");
  const fakePdfJs = (document: () => Promise<unknown>): (() => Promise<PdfJsLike>) =>
    async () => ({ getDocument: () => ({ promise: document() }) }) as unknown as PdfJsLike;

  it("names a password-protected PDF instead of an opaque pdf.js error", async () => {
    const locked = fakePdfJs(async () => {
      throw Object.assign(new Error("No password given"), { name: "PasswordException" });
    });
    await expect(extractPdfText(pdfHeader, locked)).rejects.toThrow(/password-protected/);
  });

  it("stops at the page cap even when the pages hold little text", async () => {
    let pagesRead = 0;
    const many = fakePdfJs(async () => ({
      numPages: 50_000,
      getPage: async () => {
        pagesRead += 1;
        return { getTextContent: async () => ({ items: [{ str: "Page text.", hasEOL: true }] }) };
      },
      destroy: async () => {},
    }));
    const result = await extractPdfText(pdfHeader, many);
    expect(pagesRead).toBe(MAX_PDF_PAGES);
    expect(result.warnings.join(" ")).toMatch(/first 2,000 of 50,000 pages/);
  });

  it("counts combining marks as readable (decomposed diacritics)", () => {
    const decomposed = "Tie\u0302\u0301ng Vie\u0323\u0302t ".repeat(20).normalize("NFD");
    expect(readableRatio(decomposed)).toBeGreaterThan(0.95);
  });
});
