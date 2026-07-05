import { describe, expect, it } from "vitest";
import type { ToolArtifactMetadata, ToolArtifactStoreLike, ToolArtifactWriteInput } from "../src/artifacts/tool-artifact-store";
import { parseSourceReference } from "../src/retrieval/citations";
import { legacyStableTextHash } from "../src/retrieval/source-hash";
import {
  SOURCE_IMPORT_CONTENT_TYPE,
  SOURCE_IMPORT_SOURCE_TOOL,
  SourceArtifactDeduper,
  createSourceImportProvenance,
  extractReadableSource,
  formatSourceImportArtifact,
  parseSourceImportProvenance,
} from "../src/retrieval/source-artifacts";

const FIXED_IMPORTED_AT = "2026-06-26T08:00:00.000Z";

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

describe("source import artifacts", () => {
  it("prefers readable article/main content over page chrome", () => {
    const html = `<!doctype html>
      <html>
        <head><title>Vault QA design</title></head>
        <body>
          <nav>Home Pricing Login</nav>
          <article>
            <h1>Vault QA design</h1>
            <p>Lexical retrieval should gather grounded note evidence before optional embeddings.</p>
            <p>Multilingual queries need language-aware token normalization.</p>
          </article>
          <footer>Copyright and newsletter signup</footer>
        </body>
      </html>`;

    const extracted = extractReadableSource(html, "text/html");

    expect(extracted.extractor).toBe("readability-lite");
    expect(extracted.title).toBe("Vault QA design");
    expect(extracted.text).toContain("Lexical retrieval should gather grounded note evidence");
    expect(extracted.text).toContain("Multilingual queries need language-aware token normalization");
    expect(extracted.text).not.toContain("Pricing");
    expect(extracted.text).not.toContain("newsletter");
  });

  it("falls back to regex extraction when no readable container exists", () => {
    const extracted = extractReadableSource(
      `<html><body><h1>Loose page</h1><p>A short source without article markup.</p><p>Still citable.</p></body></html>`,
      "text/html",
    );

    expect(extracted.extractor).toBe("regex-fallback");
    expect(extracted.title).toBe("Loose page");
    expect(extracted.text).toContain("A short source without article markup.");
    expect(extracted.text).toContain("Still citable.");
  });

  it("classifies video-like HTML source metadata without changing readable extraction", () => {
    const extracted = extractReadableSource(
      `<html>
        <head>
          <title>Talk recording</title>
          <meta property="og:type" content="video.other">
          <meta property="og:video" content="https://cdn.example.com/talk.mp4">
        </head>
        <body><main><p>Transcript-adjacent notes for the recorded talk.</p></main></body>
      </html>`,
      "text/html",
    );

    expect(extracted.sourceKind).toBe("video");
    expect(extracted.mediaUrl).toBe("https://cdn.example.com/talk.mp4");
    expect(extracted.text).toContain("Transcript-adjacent notes");
  });

  it("formats and parses durable provenance for source artifacts", async () => {
    const provenance = await createSourceImportProvenance({
      url: "https://example.com/research?b=2&a=1#section",
      finalUrl: "https://example.com/research?a=1&b=2",
      title: "Multilingual Q&A",
      text: "A grounded source about multilingual Q&A.",
      contentType: "text/html; charset=utf-8",
      extractor: "readability-lite",
      importedAt: FIXED_IMPORTED_AT,
    });
    const artifact = formatSourceImportArtifact(provenance, "A grounded source about multilingual Q&A.");

    expect(artifact).toContain("agentic_chat_source: 1");
    expect(artifact).toContain('title: "Multilingual Q&A"');
    expect(provenance.textHash).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact).toContain("Source: [Multilingual Q&A](https://example.com/research?a=1&b=2)");
    expect(artifact).toContain("## Extracted source text");
    expect(parseSourceImportProvenance(artifact)).toEqual(provenance);
  });

  it("deduplicates repeated source imports by canonical URL and extracted text", async () => {
    const { store, writes } = memoryArtifactStore();
    const deduper = new SourceArtifactDeduper();

    const first = await deduper.write(store, {
      url: "https://example.com/page?b=2&a=1#ignored",
      title: "Research Source",
      text: "same extracted text",
      contentType: "text/html",
      extractor: "readability-lite",
      importedAt: FIXED_IMPORTED_AT,
    });
    const second = await deduper.write(store, {
      url: "https://example.com/page?a=1&b=2",
      title: "Research Source",
      text: "same extracted text",
      contentType: "text/html",
      extractor: "readability-lite",
      importedAt: "2026-06-26T09:00:00.000Z",
    });

    expect(writes).toHaveLength(1);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.metadata.id).toBe(first.metadata.id);
    expect(second.provenance.dedupKey).toBe(first.provenance.dedupKey);
  });

  it("reuses a persisted source artifact when the dedupe cache is cold", async () => {
    const { store, writes } = memoryArtifactStore();

    const first = await new SourceArtifactDeduper().write(store, {
      url: "https://example.com/persisted",
      title: "Persisted Source",
      text: "persisted extracted text",
      contentType: "text/html",
      extractor: "readability-lite",
      importedAt: FIXED_IMPORTED_AT,
    });
    const second = await new SourceArtifactDeduper().write(store, {
      url: "https://example.com/persisted",
      title: "Persisted Source",
      text: "persisted extracted text",
      contentType: "text/html",
      extractor: "readability-lite",
      importedAt: "2026-06-26T09:00:00.000Z",
    });

    expect(writes).toHaveLength(1);
    expect(second.duplicate).toBe(true);
    expect(second.metadata.id).toBe(first.metadata.id);
    expect(second.text).toBe(first.text);
  });

  it("reuses source artifacts written with the legacy FNV text hash", async () => {
    const { store, writes } = memoryArtifactStore();
    const url = "https://example.com/legacy-source";
    const text = "legacy extracted source text";
    const textHash = legacyStableTextHash(text);
    const provenance = {
      url,
      extractor: "plain-text" as const,
      sourceKind: "web" as const,
      importedAt: FIXED_IMPORTED_AT,
      dedupKey: `source:${url}:${textHash}`,
      textHash,
      sourceTextChars: text.length,
    };
    await store.writeArtifact({
      label: "Legacy Source",
      sourceToolName: SOURCE_IMPORT_SOURCE_TOOL,
      contentType: SOURCE_IMPORT_CONTENT_TYPE,
      dedupKey: provenance.dedupKey,
      sourceUrl: url,
      sourceKind: "web",
      sourceTextHash: textHash,
      text: formatSourceImportArtifact(provenance, text),
    });

    const duplicate = await new SourceArtifactDeduper().write(store, {
      url,
      title: "Legacy Source",
      text,
      contentType: "text/plain",
      extractor: "plain-text",
      importedAt: "2026-06-26T09:00:00.000Z",
    });

    expect(writes).toHaveLength(1);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.metadata.id).toBe("artifact-1");
  });

  it("returns artifact citations that the citation parser understands", async () => {
    const { store, writes } = memoryArtifactStore();
    const result = await new SourceArtifactDeduper().write(store, {
      url: "https://example.com/deep-research",
      title: "Deep Research Source",
      text: "Collected source text for a deep research answer.",
      contentType: "text/html",
      extractor: "readability-lite",
      importedAt: FIXED_IMPORTED_AT,
    });

    expect(writes[0]).toMatchObject({
      sourceToolName: SOURCE_IMPORT_SOURCE_TOOL,
      contentType: SOURCE_IMPORT_CONTENT_TYPE,
      sourceKind: "web",
    });
    expect(parseSourceReference(result.artifactCitation)).toEqual({
      type: "artifact",
      artifactId: "artifact-1",
      label: "Deep Research Source",
    });
  });

  it("stores an inspectable deep-research source artifact with extraction provenance", async () => {
    const { store, writes } = memoryArtifactStore();
    const html = `<!doctype html>
      <html>
        <head><title>Deep research fixture</title></head>
        <body>
          <header>Subscribe and share</header>
          <main>
            <h1>Deep research fixture</h1>
            <p>Q/A, RAG, and similarity can use lexical retrieval before embeddings.</p>
            <p>Embedding generation is optional infrastructure for large vaults without GPU acceleration.</p>
          </main>
        </body>
      </html>`;
    const extracted = extractReadableSource(html, "text/html");

    await new SourceArtifactDeduper().write(store, {
      url: "https://example.com/deep-research-fixture",
      title: extracted.title,
      text: extracted.text,
      contentType: "text/html",
      extractor: extracted.extractor,
      importedAt: FIXED_IMPORTED_AT,
    });

    const artifact = writes[0].text;
    expect(artifact).toContain('title: "Deep research fixture"');
    expect(artifact).toContain("extractor: readability-lite");
    expect(artifact).toContain("Q/A, RAG, and similarity can use lexical retrieval before embeddings.");
    expect(artifact).toContain("Embedding generation is optional infrastructure");
    expect(artifact).not.toContain("Subscribe and share");
    expect(parseSourceImportProvenance(artifact)).toMatchObject({
      url: "https://example.com/deep-research-fixture",
      extractor: "readability-lite",
      sourceTextChars: extracted.text.length,
    });
  });
});
