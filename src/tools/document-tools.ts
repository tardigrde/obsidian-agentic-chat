import type { App, DataAdapter } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import {
  DocumentArtifactDeduper,
  documentKindFromPath,
  type DocumentInput,
  type DocumentImportWriteResult,
} from "../retrieval/document-ingest";
import { PdfArtifactDeduper, type PdfInput } from "../retrieval/pdf-ingest";
import { normalizeVaultPath } from "../vault/path";

const ImportPdfParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path to a PDF file." }),
  title: Type.Optional(Type.String({ description: "Optional human-readable title for the imported PDF artifact." })),
  maxChunkChars: Type.Optional(Type.Number({ description: "Maximum characters per stored artifact chunk. Defaults to 8000." })),
});

const ImportDocumentParameters = Type.Object({
  path: Type.String({ description: "Vault-relative path to a PDF, EPUB, DOCX, PPTX, or XLSX file." }),
  title: Type.Optional(Type.String({ description: "Optional human-readable title for the imported source artifact." })),
  maxChunkChars: Type.Optional(Type.Number({ description: "Maximum characters per stored artifact chunk. Defaults to 8000." })),
});

export function createDocumentTools(app: App, artifactStore: ToolArtifactStoreLike | undefined): AgentTool[] {
  if (!artifactStore) return [];
  const pdfArtifacts = new PdfArtifactDeduper();
  const documentArtifacts = new DocumentArtifactDeduper();
  return [
    createImportPdfTool(app.vault.adapter, artifactStore, pdfArtifacts),
    createImportDocumentTool(app.vault.adapter, artifactStore, pdfArtifacts, documentArtifacts),
  ];
}

function createImportPdfTool(
  adapter: DataAdapter | undefined,
  artifactStore: ToolArtifactStoreLike,
  pdfArtifacts: PdfArtifactDeduper,
): AgentTool<typeof ImportPdfParameters> {
  return {
    name: "import_pdf",
    label: "Import PDF",
    description:
      "Extract text from a vault PDF into a plugin-managed source artifact with provenance and citation anchors. " +
      "Returns the artifact citation instead of dumping the full PDF text into context.",
    parameters: ImportPdfParameters,
    execute: async (_id, params) => {
      if (!adapter) throw new Error("Vault adapter is unavailable.");
      const path = normalizePdfPath(String(params.path ?? ""));
      const data = await readPdfData(adapter, path);
      const result = await pdfArtifacts.write(artifactStore, {
        sourcePath: path,
        title: normalizeOptionalString(params.title),
        maxChunkChars: normalizeMaxChunkChars(params.maxChunkChars),
        data,
      });
      return {
        content: [{ type: "text", text: formatImportPdfResult(result) }],
        details: {
          path,
          title: result.provenance.title,
          sourceArtifactId: result.metadata.id,
          sourceArtifactCitation: result.artifactCitation,
          sourceArtifactDuplicate: result.duplicate,
          sourceDedupKey: result.provenance.dedupKey,
          extractor: result.provenance.extractor,
          pageCount: result.provenance.pageCount,
          chunkCount: result.provenance.chunkCount,
          totalChars: result.provenance.sourceTextChars,
          citationAnchors: result.chunks.map((chunk) => ({
            anchor: chunk.anchor,
            label: `Chunk ${chunk.index}`,
            start: chunk.start,
            end: chunk.end,
          })),
        },
      };
    },
  };
}

function createImportDocumentTool(
  adapter: DataAdapter | undefined,
  artifactStore: ToolArtifactStoreLike,
  pdfArtifacts: PdfArtifactDeduper,
  documentArtifacts: DocumentArtifactDeduper,
): AgentTool<typeof ImportDocumentParameters> {
  return {
    name: "import_document",
    label: "Import document",
    description:
      "Extract text from a vault PDF, EPUB, DOCX, PPTX, or XLSX file into a plugin-managed source artifact with provenance and citation anchors. " +
      "Returns the artifact citation instead of dumping the full document text into context. Legacy binary Office files (.doc/.ppt/.xls) are unsupported.",
    parameters: ImportDocumentParameters,
    execute: async (_id, params) => {
      if (!adapter) throw new Error("Vault adapter is unavailable.");
      const path = normalizeDocumentPath(String(params.path ?? ""));
      const title = normalizeOptionalString(params.title);
      const maxChunkChars = normalizeMaxChunkChars(params.maxChunkChars);
      if (path.toLowerCase().endsWith(".pdf")) {
        const data = await readPdfData(adapter, path);
        const result = await pdfArtifacts.write(artifactStore, {
          sourcePath: path,
          title,
          maxChunkChars,
          data,
        });
        return {
          content: [{ type: "text", text: formatImportPdfResult(result) }],
          details: pdfImportDetails(path, result),
        };
      }

      documentKindFromPath(path);
      const data = await readDocumentData(adapter, path);
      const writeDocumentArtifact = documentArtifacts.write.bind(documentArtifacts);
      const result = await writeDocumentArtifact(artifactStore, {
        sourcePath: path,
        title,
        maxChunkChars,
        data,
      });
      return {
        content: [{ type: "text", text: formatImportDocumentResult(result) }],
        details: documentImportDetails(path, result),
      };
    },
  };
}

async function readPdfData(adapter: DataAdapter, path: string): Promise<PdfInput> {
  const binaryAdapter = adapter as DataAdapter & { readBinary?: (path: string) => Promise<ArrayBuffer> };
  if (binaryAdapter.readBinary) return binaryAdapter.readBinary(path);
  return adapter.read(path);
}

function normalizePdfPath(value: string): string {
  const path = normalizeVaultPath(value);
  if (!path) throw new Error("path is required.");
  if (!path.toLowerCase().endsWith(".pdf")) throw new Error("import_pdf only supports .pdf files.");
  return path;
}

function normalizeDocumentPath(value: string): string {
  const path = normalizeVaultPath(value);
  if (!path) throw new Error("path is required.");
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) return path;
  documentKindFromPath(path);
  return path;
}

async function readDocumentData(adapter: DataAdapter, path: string): Promise<DocumentInput> {
  const binaryAdapter = adapter as DataAdapter & { readBinary?: (path: string) => Promise<ArrayBuffer> };
  if (binaryAdapter.readBinary) return binaryAdapter.readBinary(path);
  return adapter.read(path);
}

function normalizeOptionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function normalizeMaxChunkChars(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function formatImportPdfResult(result: Awaited<ReturnType<PdfArtifactDeduper["write"]>>): string {
  const duplicate = result.duplicate ? " (already imported)" : "";
  const pageCount = result.provenance.pageCount === null ? "unknown pages" : `${result.provenance.pageCount} page(s)`;
  return [
    `PDF source artifact: ${result.artifactCitation}${duplicate}`,
    `Extracted ${result.provenance.sourceTextChars} characters across ${result.provenance.chunkCount} chunk(s), ${pageCount}.`,
    "Use read_artifact with the artifact id to inspect cited chunks.",
  ].join("\n");
}

function formatImportDocumentResult(result: DocumentImportWriteResult): string {
  const duplicate = result.duplicate ? " (already imported)" : "";
  return [
    `${result.provenance.kind.toUpperCase()} source artifact: ${result.artifactCitation}${duplicate}`,
    `Extracted ${result.provenance.sourceTextChars} characters across ${result.provenance.chunkCount} chunk(s), ${result.provenance.itemCount} item(s).`,
    "Use read_artifact with the artifact id to inspect cited chunks.",
  ].join("\n");
}

function pdfImportDetails(path: string, result: Awaited<ReturnType<PdfArtifactDeduper["write"]>>): Record<string, unknown> {
  return {
    path,
    sourceKind: "pdf",
    title: result.provenance.title,
    sourceArtifactId: result.metadata.id,
    sourceArtifactCitation: result.artifactCitation,
    sourceArtifactDuplicate: result.duplicate,
    sourceDedupKey: result.provenance.dedupKey,
    extractor: result.provenance.extractor,
    pageCount: result.provenance.pageCount,
    chunkCount: result.provenance.chunkCount,
    totalChars: result.provenance.sourceTextChars,
    citationAnchors: result.chunks.map((chunk) => ({
      anchor: chunk.anchor,
      label: `Chunk ${chunk.index}`,
      start: chunk.start,
      end: chunk.end,
    })),
  };
}

function documentImportDetails(path: string, result: DocumentImportWriteResult): Record<string, unknown> {
  return {
    path,
    sourceKind: result.provenance.kind,
    title: result.provenance.title,
    sourceArtifactId: result.metadata.id,
    sourceArtifactCitation: result.artifactCitation,
    sourceArtifactDuplicate: result.duplicate,
    sourceDedupKey: result.provenance.dedupKey,
    extractor: result.provenance.extractor,
    itemCount: result.provenance.itemCount,
    chunkCount: result.provenance.chunkCount,
    totalChars: result.provenance.sourceTextChars,
    citationAnchors: result.chunks.map((chunk) => ({
      anchor: chunk.anchor,
      label: `Chunk ${chunk.index}`,
      start: chunk.start,
      end: chunk.end,
    })),
  };
}
