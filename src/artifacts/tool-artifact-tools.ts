import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { truncateToolOutput } from "../vault/truncate";
import type { ToolArtifactStoreLike, ToolArtifactReadResult } from "./tool-artifact-store";

const DEFAULT_READ_LIMIT = 12_000;
const MAX_READ_LIMIT = 30_000;
const DEFAULT_EXPORT_LIMIT = 50_000;
const MAX_EXPORT_LIMIT = 100_000;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_SEARCH_MATCHES = 10;
const MAX_SEARCH_MATCHES = 50;
const SEARCH_CONTEXT_CHARS = 220;

export function createToolArtifactTools(store: ToolArtifactStoreLike | undefined): AgentTool[] {
  if (!store) return [];
  const tools: AgentTool[] = [];
  if (store.listArtifacts) tools.push(createListArtifactsTool(store));
  tools.push(createReadArtifactTool(store), createSearchArtifactTool(store), createExportArtifactTool(store));
  return tools;
}

function createListArtifactsTool(store: ToolArtifactStoreLike): AgentTool {
  return {
    name: "list_artifacts",
    label: "List artifacts",
    description:
      "List recent plugin-managed artifacts by metadata. Use this to find imported source artifacts before reading or exporting one.",
    parameters: Type.Object({
      sourceKind: Type.Optional(
        Type.String({ description: "Optional source kind filter, such as web, pdf, epub, docx, pptx, or xlsx." }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          description: `Maximum artifacts to list. Defaults to ${DEFAULT_LIST_LIMIT}.`,
        }),
      ),
    }),
    execute: async (_id, params) => {
      const sourceKind = normalizeSourceKind((params as { sourceKind?: string }).sourceKind);
      const limit = normalizeLimit((params as { limit?: number }).limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const artifacts = (await store.listArtifacts?.()) ?? [];
      const visible = artifacts
        .filter((artifact) => !sourceKind || artifact.sourceKind === sourceKind)
        .slice(0, limit);
      return {
        content: [{ type: "text", text: formatArtifactList(visible, sourceKind) }],
        details: {
          count: visible.length,
          sourceKind,
          limit,
          totalAvailable: artifacts.length,
        },
      };
    },
  };
}

function createReadArtifactTool(store: ToolArtifactStoreLike): AgentTool {
  return {
    name: "read_artifact",
    label: "Read artifact",
    description:
      "Read a plugin-managed artifact that was returned by a previous tool call. " +
      "Use this to inspect large MCP results by id without re-running the remote tool.",
    parameters: Type.Object({
      id: Type.String({ description: "Artifact id from a previous tool result." }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "0-based character offset to start reading from." })),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_READ_LIMIT,
          description: `Maximum characters to read. Defaults to ${DEFAULT_READ_LIMIT}.`,
        }),
      ),
    }),
    execute: async (_id, params) => {
      const read = await store.readArtifact(String((params as { id: string }).id));
      const offset = normalizeOffset((params as { offset?: number }).offset, read.text.length);
      const limit = normalizeLimit((params as { limit?: number }).limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
      const end = Math.min(read.text.length, offset + limit);
      const chunk = read.text.slice(offset, end);
      return {
        content: [{ type: "text", text: truncateToolOutput(formatArtifactRead(read, offset, end, chunk), MAX_READ_LIMIT + 1_000) }],
        details: {
          artifactId: read.metadata.id,
          offset,
          limit,
          returnedChars: chunk.length,
          totalChars: read.text.length,
          truncated: end < read.text.length,
        },
      };
    },
  };
}

function createSearchArtifactTool(store: ToolArtifactStoreLike): AgentTool {
  return {
    name: "search_artifact",
    label: "Search artifact",
    description:
      "Search a plugin-managed artifact that was returned by a previous tool call. " +
      "Use this to locate terms inside large MCP results before reading a chunk.",
    parameters: Type.Object({
      id: Type.String({ description: "Artifact id from a previous tool result." }),
      query: Type.String({ minLength: 1, description: "Case-insensitive text to search for." }),
      maxMatches: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_SEARCH_MATCHES,
          description: `Maximum matches to return. Defaults to ${DEFAULT_SEARCH_MATCHES}.`,
        }),
      ),
    }),
    execute: async (_id, params) => {
      const id = String((params as { id: string }).id);
      const query = String((params as { query: string }).query);
      const maxMatches = normalizeLimit(
        (params as { maxMatches?: number }).maxMatches,
        DEFAULT_SEARCH_MATCHES,
        MAX_SEARCH_MATCHES,
      );
      const read = await store.readArtifact(id);
      const matches = findMatches(read.text, query, maxMatches);
      return {
        content: [{ type: "text", text: formatArtifactSearch(read, query, matches) }],
        details: {
          artifactId: read.metadata.id,
          query,
          matches: matches.length,
          totalChars: read.text.length,
        },
      };
    },
  };
}

function createExportArtifactTool(store: ToolArtifactStoreLike): AgentTool {
  return {
    name: "export_artifact",
    label: "Export artifact",
    description:
      "Return a bounded export payload for a plugin-managed artifact. This is read-only; write the returned text with the normal write tool if the user wants it saved in the vault.",
    parameters: Type.Object({
      id: Type.String({ description: "Artifact id from a previous tool result." }),
      format: Type.Optional(Type.String({ description: 'Export format: "markdown" or "json". Defaults to markdown.' })),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_EXPORT_LIMIT,
          description: `Maximum artifact characters to include. Defaults to ${DEFAULT_EXPORT_LIMIT}.`,
        }),
      ),
    }),
    execute: async (_id, params) => {
      const read = await store.readArtifact(String((params as { id: string }).id));
      const format = normalizeExportFormat((params as { format?: string }).format);
      const limit = normalizeLimit((params as { limit?: number }).limit, DEFAULT_EXPORT_LIMIT, MAX_EXPORT_LIMIT);
      const truncated = read.text.length > limit;
      const payload = formatArtifactExport(read, format, limit);
      return {
        content: [{ type: "text", text: truncateToolOutput(payload, MAX_EXPORT_LIMIT + 2_000) }],
        details: {
          artifactId: read.metadata.id,
          format,
          limit,
          returnedChars: Math.min(read.text.length, limit),
          totalChars: read.text.length,
          truncated,
        },
      };
    },
  };
}

function normalizeOffset(value: number | undefined, totalChars: number): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), totalChars);
}

function normalizeLimit(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.min(Math.max(1, Math.trunc(value)), maxValue);
}

function normalizeSourceKind(value: string | undefined): string | undefined {
  const text = value?.trim().toLowerCase();
  return text || undefined;
}

function normalizeExportFormat(value: string | undefined): "markdown" | "json" {
  if (value === undefined || value.trim() === "" || value === "markdown") return "markdown";
  if (value === "json") return "json";
  throw new Error('export_artifact: format must be "markdown" or "json".');
}

function artifactMetadataLines(read: ToolArtifactReadResult): string[] {
  return [
    `Artifact ${read.metadata.id}`,
    `Label: ${read.metadata.label}`,
    `Source tool: ${read.metadata.sourceToolName}`,
    read.metadata.sourceKind ? `Source kind: ${read.metadata.sourceKind}` : null,
    read.metadata.sourceTextHash ? `Source text hash: ${read.metadata.sourceTextHash}` : null,
    read.metadata.sourceUrl ? `Source URL: ${read.metadata.sourceUrl}` : null,
  ].filter((line): line is string => line !== null);
}

function formatArtifactRead(read: ToolArtifactReadResult, offset: number, end: number, chunk: string): string {
  const range = chunk.length > 0 ? `${offset}-${end - 1}` : `${offset}-${offset}`;
  const header = [
    ...artifactMetadataLines(read),
    `Characters ${range} of ${read.text.length}${end < read.text.length ? " (truncated)" : ""}`,
  ].join("\n");
  const next = end < read.text.length ? `\n\nNext chunk: call read_artifact with offset ${end}.` : "";
  return `${header}\n\n${chunk}${next}`;
}

interface ArtifactMatch {
  offset: number;
  line: number;
  snippet: string;
}

function findMatches(text: string, query: string, maxMatches: number): ArtifactMatch[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const matches: ArtifactMatch[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1 && matches.length < maxMatches) {
    matches.push({
      offset: index,
      line: lineNumberAt(text, index),
      snippet: snippetAt(text, index, query.length),
    });
    index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
  }
  return matches;
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if ((text.codePointAt(index) ?? 0) === 10) line += 1;
  }
  return line;
}

function snippetAt(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - SEARCH_CONTEXT_CHARS);
  const end = Math.min(text.length, offset + length + SEARCH_CONTEXT_CHARS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function formatArtifactSearch(read: ToolArtifactReadResult, query: string, matches: ArtifactMatch[]): string {
  const header = [
    ...artifactMetadataLines(read),
    `Query: ${query}`,
  ].join("\n");
  if (matches.length === 0) return `${header}\n\nNo matches.`;
  const rows = matches.map((match, index) => `${index + 1}. offset ${match.offset}, line ${match.line}: ${match.snippet}`);
  return `${header}\n\n${rows.join("\n")}`;
}

function formatArtifactList(artifacts: readonly ToolArtifactReadResult["metadata"][], sourceKind: string | undefined): string {
  const header = sourceKind ? `Artifacts matching source kind "${sourceKind}"` : "Recent artifacts";
  if (artifacts.length === 0) return `${header}\n\nNo artifacts found.`;
  const rows = artifacts.map((artifact, index) => {
    const parts = [
      `${index + 1}. ${artifact.id}`,
      artifact.label,
      artifact.sourceKind ? `kind=${artifact.sourceKind}` : null,
      artifact.pinned ? "pinned=true" : null,
      `tool=${artifact.sourceToolName}`,
      `chars=${artifact.charLength}`,
      artifact.byteLength !== undefined ? `bytes=${artifact.byteLength}` : null,
      artifact.createdAt ? `created=${artifact.createdAt}` : null,
    ].filter((part): part is string => part !== null);
    return parts.join(" | ");
  });
  return `${header}\n\n${rows.join("\n")}`;
}

function formatArtifactExport(read: ToolArtifactReadResult, format: "markdown" | "json", limit: number): string {
  const text = read.text.slice(0, limit);
  const truncated = read.text.length > limit;
  if (format === "json") {
    return JSON.stringify(
      {
        metadata: read.metadata,
        text,
        truncated,
        totalChars: read.text.length,
      },
      null,
      2,
    );
  }
  const header = [
    `# Artifact export: ${read.metadata.label}`,
    "",
    `- id: ${read.metadata.id}`,
    `- source_tool: ${read.metadata.sourceToolName}`,
    `- content_type: ${read.metadata.contentType}`,
    read.metadata.sourceKind ? `- source_kind: ${read.metadata.sourceKind}` : null,
    read.metadata.sourceTextHash ? `- source_text_hash: ${read.metadata.sourceTextHash}` : null,
    read.metadata.sourceUrl ? `- source_url: ${read.metadata.sourceUrl}` : null,
    `- characters: ${read.text.length}`,
    read.metadata.byteLength !== undefined ? `- bytes: ${read.metadata.byteLength}` : null,
    truncated ? `- truncated: true; call export_artifact with a larger limit or read_artifact with offsets for the rest.` : null,
    "",
    "## Content",
    "",
  ].filter((line): line is string => line !== null);
  return `${header.join("\n")}${text}`;
}
