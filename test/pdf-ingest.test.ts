import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { ToolArtifactMetadata, ToolArtifactStoreLike, ToolArtifactWriteInput } from "../src/artifacts/tool-artifact-store";
import { createDocumentTools } from "../src/tools/document-tools";
import { parseSourceReference } from "../src/retrieval/citations";
import { legacyStableTextHash } from "../src/retrieval/source-hash";
import {
  PDF_IMPORT_CONTENT_TYPE,
  PDF_IMPORT_SOURCE_TOOL,
  PdfArtifactDeduper,
  chunkPdfText,
  extractPdfText,
  formatPdfImportArtifact,
  parsePdfImportProvenance,
  writePdfSourceArtifact,
} from "../src/retrieval/pdf-ingest";
import { MemoryAdapter } from "./helpers/memory-adapter";

const FIXED_IMPORTED_AT = "2026-06-26T08:00:00.000Z";

const PDF_FIXTURE = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj
4 0 obj << /Length 180 >> stream
BT /F1 12 Tf 72 720 Td (Q/A and RAG can use lexical retrieval before embeddings.) Tj
0 -16 Td (Multilingual notes need language-aware token normalization.) Tj
0 -16 Td <456d62656464696e677320617265206f7074696f6e616c20696e6672617374727563747572652e> Tj ET
endstream endobj
%%EOF`;

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

describe("PDF source ingestion", () => {
  it("extracts text from literal and hex PDF strings with page provenance", () => {
    const extracted = extractPdfText(PDF_FIXTURE);

    expect(extracted.extractor).toBe("pdf-text-lite");
    expect(extracted.pageCount).toBe(1);
    expect(extracted.text).toContain("Q/A and RAG can use lexical retrieval before embeddings.");
    expect(extracted.text).toContain("Multilingual notes need language-aware token normalization.");
    expect(extracted.text).toContain("Embeddings are optional infrastructure.");
  });

  it("chunks extracted PDF text into durable citation anchors", () => {
    const chunks = chunkPdfText(extractPdfText(PDF_FIXTURE).text, { maxChars: 48 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.anchor)).toEqual(chunks.map((_, index) => `pdf-chunk-${index + 1}`));
    expect(chunks.every((chunk) => chunk.text.length <= 48)).toBe(true);
  });

  it("writes PDF artifacts with provenance, anchors, and parser-readable artifact citations", async () => {
    const { store, writes } = memoryArtifactStore();

    const result = await writePdfSourceArtifact(store, {
      sourcePath: "Research/embeddings.pdf",
      title: "Embedding tradeoffs",
      data: PDF_FIXTURE,
      importedAt: FIXED_IMPORTED_AT,
      maxChunkChars: 64,
    });

    expect(writes[0]).toMatchObject({
      sourceToolName: PDF_IMPORT_SOURCE_TOOL,
      contentType: PDF_IMPORT_CONTENT_TYPE,
      dedupKey: result.provenance.dedupKey,
      sourceKind: "pdf",
      sourceTextHash: result.provenance.textHash,
    });
    expect(writes[0].text).toContain("agentic_chat_pdf_source: 1");
    expect(writes[0].text).toContain('source_path: "Research/embeddings.pdf"');
    expect(result.provenance.textHash).toMatch(/^[a-f0-9]{64}$/);
    expect(writes[0].text).toContain("<!-- pdf-chunk-1 characters 0-");
    expect(writes[0].text).toContain("^pdf-chunk-1");
    expect(parsePdfImportProvenance(writes[0].text)).toEqual(result.provenance);
    expect(parseSourceReference(result.artifactCitation)).toEqual({
      type: "artifact",
      artifactId: "artifact-1",
      label: "Embedding tradeoffs",
    });
  });

  it("deduplicates repeated PDF imports by source path and extracted text", async () => {
    const { store, writes } = memoryArtifactStore();
    const deduper = new PdfArtifactDeduper();

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
    const extracted = extractPdfText(PDF_FIXTURE);
    const sourceText = extracted.text.trim();
    const textHash = legacyStableTextHash(sourceText);
    const chunks = chunkPdfText(sourceText, { maxChars: 64 });
    const provenance = {
      sourcePath,
      title: "Legacy PDF",
      extractor: "pdf-text-lite" as const,
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

    const duplicate = await new PdfArtifactDeduper().write(store, {
      sourcePath,
      title: "Legacy PDF",
      data: PDF_FIXTURE,
      importedAt: "2026-06-26T09:00:00.000Z",
    });

    expect(writes).toHaveLength(1);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.metadata.id).toBe("artifact-1");
  });

  it("rejects unsupported files and image-only PDFs without hidden fallback text", () => {
    expect(() => extractPdfText("not a pdf")).toThrow(/expected a PDF header/i);
    expect(() => extractPdfText("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF")).toThrow(/no extractable text/i);
  });

  it("imports a vault PDF through the agent document tool without stuffing full text into the response", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("Research/embeddings.pdf", PDF_FIXTURE);
    const { store, writes } = memoryArtifactStore();
    const [tool] = createDocumentTools(
      { vault: { adapter: adapter.asDataAdapter() } } as unknown as App,
      store,
    );

    const result = await tool.execute("call-1", {
      path: "Research/embeddings.pdf",
      title: "Embedding tradeoffs",
      maxChunkChars: 64,
    });
    const firstContent = result.content[0];

    expect(firstContent.type).toBe("text");
    if (firstContent.type !== "text") throw new Error("Expected text tool content.");
    expect(firstContent.text).toContain("PDF source artifact: [Embedding tradeoffs](artifact:artifact-1)");
    expect(firstContent.text).not.toContain("Q/A and RAG can use lexical retrieval");
    expect(writes).toHaveLength(1);
    expect(result.details).toMatchObject({
      path: "Research/embeddings.pdf",
      sourceArtifactId: "artifact-1",
      sourceArtifactDuplicate: false,
      extractor: "pdf-text-lite",
      pageCount: 1,
      chunkCount: 3,
      totalChars: extractPdfText(PDF_FIXTURE).text.length,
    });
    expect((result.details as { citationAnchors: Array<{ anchor: string }> }).citationAnchors.map((anchor) => anchor.anchor)).toEqual([
      "pdf-chunk-1",
      "pdf-chunk-2",
      "pdf-chunk-3",
    ]);
  });

  it("rejects non-PDF vault paths before reading unsupported files", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("Research/source.txt", "not a pdf");
    const { store } = memoryArtifactStore();
    const [tool] = createDocumentTools({ vault: { adapter: adapter.asDataAdapter() } } as unknown as App, store);

    await expect(tool.execute("call-1", { path: "Research/source.txt" })).rejects.toThrow(/only supports \.pdf/i);
  });
});
