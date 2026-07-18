import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import type { App } from "obsidian";
import type { ToolArtifactMetadata, ToolArtifactStoreLike, ToolArtifactWriteInput } from "../src/artifacts/tool-artifact-store";
import { createDocumentTools } from "../src/tools/document-tools";
import { parseSourceReference } from "../src/retrieval/citations";
import { legacyStableTextHash } from "../src/retrieval/source-hash";
import {
  DOCUMENT_IMPORT_CONTENT_TYPE,
  DOCUMENT_IMPORT_SOURCE_TOOL,
  DOCUMENT_IMPORT_LIMITS,
  DocumentArtifactDeduper,
  chunkDocumentText,
  extractDocumentText,
  formatDocumentImportArtifact,
  parseDocumentImportProvenance,
} from "../src/retrieval/document-ingest";
import { SourceArtifactDeduper } from "../src/retrieval/source-artifacts";
import { MemoryAdapter } from "./helpers/memory-adapter";

// ponytail: minimal DOMParser polyfill for Node test environment
class FakeDOMParser {
  parseFromString(markup: string, type: string) {
    if (type === "text/html") {
      let text = markup;
      for (const tag of ["script", "style"]) {
        let idx = 0;
        while (true) {
          const start = text.toLowerCase().indexOf(`<${tag}`, idx);
          if (start === -1) break;
          const end = text.toLowerCase().indexOf(`</${tag}>`, start);
          if (end === -1) break;
          text = text.slice(0, start) + " " + text.slice(end + `</${tag}>`.length);
          idx = start + 1;
        }
      }
      text = text.replace(/<[^>]+>/g, " ");
      return { body: { textContent: decodeEntities(text) } };
    }
    const elements: Array<{ localName: string; textContent: string }> = [];
    const regex = /<([a-zA-Z0-9_:]+)\b[^>]*>([\s\S]*?)<\/\1>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(markup)) !== null) {
      const tag = match[1];
      const localName = tag.includes(":") ? tag.split(":")[1] : tag;
      const inner = match[2].replace(/<[^>]+>/g, " ");
      elements.push({ localName, textContent: decodeEntities(inner) });
      regex.lastIndex = match.index + 1;
    }
    return {
      getElementsByTagName: (_tag: string) => elements,
    };
  }
}

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

(globalThis as unknown as { DOMParser: typeof FakeDOMParser }).DOMParser = FakeDOMParser;

const FIXED_IMPORTED_AT = "2026-06-27T08:00:00.000Z";

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

describe("document source ingestion", () => {
  it("extracts text from EPUB XHTML entries", async () => {
    const fixture = zipFixture({
      "mimetype": "application/epub+zip",
      "OEBPS/chapter1.xhtml": "<html><body><h1>Chapter 1</h1><p>Vault research &amp; citations.</p></body></html>",
      "OEBPS/chapter2.xhtml": "<html><body><p>Second chapter text.</p></body></html>",
    });

    const extracted = await extractDocumentText(fixture, "Books/research.epub");

    expect(extracted).toMatchObject({ kind: "epub", extractor: "epub-zip-lite", itemCount: 2 });
    expect(extracted.text).toContain("Chapter 1");
    expect(extracted.text).toContain("Vault research & citations.");
    expect(extracted.text).toContain("Second chapter text.");
  });

  it("extracts text from DOCX document.xml", async () => {
    const fixture = zipFixture({
      "word/document.xml": xmlText(["Agentic chat", "imports DOCX text"]),
    });

    const extracted = await extractDocumentText(fixture, "Docs/notes.docx");

    expect(extracted).toMatchObject({ kind: "docx", extractor: "ooxml-zip-lite", itemCount: 1 });
    expect(extracted.text).toContain("Agentic chat");
    expect(extracted.text).toContain("imports DOCX text");
  });

  it("extracts text from PPTX slides in numeric order", async () => {
    const fixture = zipFixture({
      "ppt/slides/slide2.xml": xmlText(["Second slide"]),
      "ppt/slides/slide1.xml": xmlText(["First slide"]),
    });

    const extracted = await extractDocumentText(fixture, "Decks/briefing.pptx");

    expect(extracted).toMatchObject({ kind: "pptx", itemCount: 2 });
    expect(extracted.text.indexOf("First slide")).toBeLessThan(extracted.text.indexOf("Second slide"));
  });

  it("extracts shared strings and worksheet values from XLSX", async () => {
    const fixture = zipFixture({
      "xl/sharedStrings.xml": xmlText(["Roadmap", "Done"]),
      "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row><c><v>42</v></c></row></sheetData></worksheet>",
    });

    const extracted = await extractDocumentText(fixture, "Sheets/status.xlsx");

    expect(extracted).toMatchObject({ kind: "xlsx", itemCount: 1 });
    expect(extracted.text).toContain("Roadmap");
    expect(extracted.text).toContain("Done");
    expect(extracted.text).toContain("42");
  });

  it("writes document artifacts with provenance, anchors, and citations", async () => {
    const { store, writes } = memoryArtifactStore();
    const deduper = new DocumentArtifactDeduper();

    const result = await deduper.write(store, {
      sourcePath: "Docs/notes.docx",
      title: "Notes",
      data: zipFixture({ "word/document.xml": xmlText(["One paragraph", "Second paragraph"]) }),
      importedAt: FIXED_IMPORTED_AT,
      maxChunkChars: 50,
    });
    const duplicate = await deduper.write(store, {
      sourcePath: "Docs/notes.docx",
      title: "Notes",
      data: zipFixture({ "word/document.xml": xmlText(["One paragraph", "Second paragraph"]) }),
      importedAt: "2026-06-27T09:00:00.000Z",
      maxChunkChars: 50,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      sourceToolName: DOCUMENT_IMPORT_SOURCE_TOOL,
      contentType: DOCUMENT_IMPORT_CONTENT_TYPE,
      dedupKey: result.provenance.dedupKey,
      sourceKind: "docx",
      sourceTextHash: result.provenance.textHash,
    });
    expect(writes[0].text).toContain("agentic_chat_document_source: 1");
    expect(writes[0].text).toContain('source_path: "Docs/notes.docx"');
    expect(writes[0].text).toContain("kind: docx");
    expect(result.provenance.textHash).toMatch(/^[a-f0-9]{64}$/);
    expect(writes[0].text).toContain("^document-chunk-1");
    expect(parseDocumentImportProvenance(writes[0].text)).toEqual(result.provenance);
    expect(parseSourceReference(result.artifactCitation)).toEqual({
      type: "artifact",
      artifactId: "artifact-1",
      label: "Notes",
    });
    expect(duplicate.duplicate).toBe(true);
  });

  it("deduplicates document imports against existing source artifacts with the same text", async () => {
    const { store, writes } = memoryArtifactStore();
    const sourceText = "Same extracted body across a web page and a DOCX.";

    const source = await new SourceArtifactDeduper().write(store, {
      url: "https://example.com/shared",
      title: "Shared source",
      text: sourceText,
      contentType: "text/html",
      extractor: "plain-text",
      importedAt: FIXED_IMPORTED_AT,
    });
    const document = await new DocumentArtifactDeduper().write(store, {
      sourcePath: "Docs/shared.docx",
      title: "Shared DOCX",
      data: zipFixture({ "word/document.xml": xmlText([sourceText]) }),
      importedAt: "2026-06-27T09:00:00.000Z",
    });

    expect(writes).toHaveLength(1);
    expect(document.duplicate).toBe(true);
    expect(document.metadata.id).toBe(source.metadata.id);
    expect(document.provenance.kind).toBe("docx");
    expect(document.provenance.textHash).toBe(source.provenance.textHash);
  });

  it("reuses document artifacts written with the legacy FNV text hash", async () => {
    const { store, writes } = memoryArtifactStore();
    const sourcePath = "docs/legacy.docx";
    const sourceText = "Legacy document body.";
    const textHash = legacyStableTextHash(sourceText);
    const chunks = chunkDocumentText(sourceText, { maxChars: 80 });
    const provenance = {
      sourcePath,
      title: "Legacy DOCX",
      kind: "docx" as const,
      extractor: "ooxml-zip-lite" as const,
      importedAt: FIXED_IMPORTED_AT,
      dedupKey: `docx:${sourcePath}:${textHash}`,
      textHash,
      sourceTextChars: sourceText.length,
      itemCount: 1,
      chunkCount: chunks.length,
    };
    await store.writeArtifact({
      label: "Legacy DOCX",
      sourceToolName: DOCUMENT_IMPORT_SOURCE_TOOL,
      contentType: DOCUMENT_IMPORT_CONTENT_TYPE,
      dedupKey: provenance.dedupKey,
      sourceKind: "docx",
      sourceTextHash: textHash,
      text: formatDocumentImportArtifact(provenance, chunks),
    });

    const duplicate = await new DocumentArtifactDeduper().write(store, {
      sourcePath,
      title: "Legacy DOCX",
      data: zipFixture({ "word/document.xml": xmlText([sourceText]) }),
      importedAt: "2026-06-27T09:00:00.000Z",
    });

    expect(writes).toHaveLength(1);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.metadata.id).toBe("artifact-1");
  });

  it("imports EPUB through the generic document tool without returning full text inline", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write(
      "Books/research.epub",
      binaryString(zipFixture({ "OEBPS/chapter.xhtml": "<html><body><p>Long source body for an EPUB.</p></body></html>" })),
    );
    const { store, writes } = memoryArtifactStore();
    const tools = createDocumentTools({ vault: { adapter: adapter.asDataAdapter() } } as unknown as App, store);
    const tool = tools.find((candidate) => candidate.name === "import_document");
    if (!tool) throw new Error("import_document tool missing");

    const result = await tool.execute("call-1", {
      path: "Books/research.epub",
      title: "Research EPUB",
      maxChunkChars: 80,
    });
    const firstContent = result.content[0];

    expect(firstContent.type).toBe("text");
    if (firstContent.type !== "text") throw new Error("Expected text tool content.");
    expect(firstContent.text).toContain("EPUB source artifact: [Research EPUB](artifact:artifact-1)");
    expect(firstContent.text).not.toContain("Long source body");
    expect(writes).toHaveLength(1);
    expect(result.details).toMatchObject({
      path: "Books/research.epub",
      sourceKind: "epub",
      sourceArtifactId: "artifact-1",
      extractor: "epub-zip-lite",
      itemCount: 1,
    });
  });

  it("rejects legacy Office files and malformed ZIP documents explicitly", async () => {
    await expect(extractDocumentText(zipFixture({ "word/document.xml": xmlText(["old"]) }), "Docs/old.doc")).rejects.toThrow(
      /legacy binary/i,
    );
    await expect(extractDocumentText("not a zip", "Docs/notes.docx")).rejects.toThrow(/ZIP-based/i);
  });

  it("rejects ZIP entries that declare unsafe expanded sizes before decompression", async () => {
    const fixture = zipFixture({ "word/document.xml": xmlText(["tiny"]) });
    const centralOffset = findSignature(fixture, 0x02014b50);
    writeUint32(fixture, centralOffset + 24, DOCUMENT_IMPORT_LIMITS.maxEntryUncompressedBytes + 1);

    await expect(extractDocumentText(fixture, "Docs/oversized.docx")).rejects.toThrow(/too large after decompression/i);
  });

  it("rejects deflated ZIP entries that exceed expansion limits while streaming", async () => {
    const limits = DOCUMENT_IMPORT_LIMITS as unknown as {
      maxEntryUncompressedBytes: number;
      maxTotalUncompressedBytes: number;
    };
    const previous = {
      maxEntryUncompressedBytes: limits.maxEntryUncompressedBytes,
      maxTotalUncompressedBytes: limits.maxTotalUncompressedBytes,
    };
    limits.maxEntryUncompressedBytes = 64;
    limits.maxTotalUncompressedBytes = 1024;
    try {
      await expect(
        extractDocumentText(
          deflatedZipFixture({
            "word/document.xml": {
              value: xmlText(["A".repeat(200)]),
              declaredUncompressedSize: 10,
            },
          }),
          "Docs/bomb.docx",
        ),
      ).rejects.toThrow(/too large after decompression/i);
    } finally {
      limits.maxEntryUncompressedBytes = previous.maxEntryUncompressedBytes;
      limits.maxTotalUncompressedBytes = previous.maxTotalUncompressedBytes;
    }
  });

  it("chunks document text into reusable anchors", () => {
    const chunks = chunkDocumentText("One paragraph is long enough to split across several reusable document chunks.", { maxChars: 40 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.anchor)).toEqual(chunks.map((_, index) => `document-chunk-${index + 1}`));
  });
});

function xmlText(values: string[]): string {
  return `<root>${values.map((value) => `<w:t>${escapeXml(value)}</w:t>`).join("")}</root>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function zipFixture(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(value);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    writeUint32(local, 0, 0x04034b50);
    writeUint16(local, 4, 20);
    writeUint16(local, 8, 0);
    writeUint32(local, 18, data.length);
    writeUint32(local, 22, data.length);
    writeUint16(local, 26, nameBytes.length);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    writeUint32(central, 0, 0x02014b50);
    writeUint16(central, 4, 20);
    writeUint16(central, 6, 20);
    writeUint16(central, 10, 0);
    writeUint32(central, 20, data.length);
    writeUint32(central, 24, data.length);
    writeUint16(central, 28, nameBytes.length);
    writeUint32(central, 42, offset);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const eocd = new Uint8Array(22);
  writeUint32(eocd, 0, 0x06054b50);
  writeUint16(eocd, 8, locals.length);
  writeUint16(eocd, 10, locals.length);
  writeUint32(eocd, 12, centralSize);
  writeUint32(eocd, 16, centralOffset);
  return concatBytes([...locals, ...centrals, eocd]);
}

function deflatedZipFixture(entries: Record<string, { value: string; declaredUncompressedSize?: number }>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, entry] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(entry.value);
    const compressed = new Uint8Array(deflateRawSync(data));
    const declaredUncompressedSize = entry.declaredUncompressedSize ?? data.length;
    const local = new Uint8Array(30 + nameBytes.length + compressed.length);
    writeUint32(local, 0, 0x04034b50);
    writeUint16(local, 4, 20);
    writeUint16(local, 8, 8);
    writeUint32(local, 18, compressed.length);
    writeUint32(local, 22, declaredUncompressedSize);
    writeUint16(local, 26, nameBytes.length);
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    writeUint32(central, 0, 0x02014b50);
    writeUint16(central, 4, 20);
    writeUint16(central, 6, 20);
    writeUint16(central, 10, 8);
    writeUint32(central, 20, compressed.length);
    writeUint32(central, 24, declaredUncompressedSize);
    writeUint16(central, 28, nameBytes.length);
    writeUint32(central, 42, offset);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const eocd = new Uint8Array(22);
  writeUint32(eocd, 0, 0x06054b50);
  writeUint16(eocd, 8, locals.length);
  writeUint16(eocd, 10, locals.length);
  writeUint32(eocd, 12, centralSize);
  writeUint32(eocd, 16, centralOffset);
  return concatBytes([...locals, ...centrals, eocd]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function binaryString(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return output;
}

function findSignature(bytes: Uint8Array, signature: number): number {
  for (let offset = 0; offset <= bytes.length - 4; offset += 1) {
    if (
      bytes[offset] === (signature & 0xff) &&
      bytes[offset + 1] === ((signature >>> 8) & 0xff) &&
      bytes[offset + 2] === ((signature >>> 16) & 0xff) &&
      bytes[offset + 3] === ((signature >>> 24) & 0xff)
    ) {
      return offset;
    }
  }
  throw new Error(`Signature not found: ${signature.toString(16)}`);
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
