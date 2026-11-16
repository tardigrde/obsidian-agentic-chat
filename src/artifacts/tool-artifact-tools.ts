import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { truncateToolOutput } from "../vault/truncate";
import { toolResult, untrustedToolResult } from "../tools/result";
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

export const ARTIFACT_TOOL_NAME = "artifact";

const ARTIFACT_ACTIONS = ["list", "search", "read", "export"] as const;
type ArtifactAction = (typeof ARTIFACT_ACTIONS)[number];

const ArtifactParameters = Type.Object({
  action: Type.Unsafe<ArtifactAction>({
    type: "string",
    enum: [...ARTIFACT_ACTIONS],
    description: "list recent artifacts, search one, read a chunk, or export it",
  }),
  id: Type.Optional(Type.String({ description: "artifact id from a previous result (search/read/export)" })),
  query: Type.Optional(Type.String({ description: "case-insensitive text to find (search)" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "0-based char offset (read)" })),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_EXPORT_LIMIT,
      description:
        `list: max artifacts (default ${DEFAULT_LIST_LIMIT}); read: max chars (default ${DEFAULT_READ_LIMIT}); ` +
        `export: max chars (default ${DEFAULT_EXPORT_LIMIT})`,
    }),
  ),
  maxMatches: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_SEARCH_MATCHES,
      description: `max matches (search, default ${DEFAULT_SEARCH_MATCHES})`,
    }),
  ),
  sourceKind: Type.Optional(Type.String({ description: "kind filter: web, pdf, epub, docx, pptx, xlsx (list)" })),
  format: Type.Optional(Type.String({ description: "markdown|json (export)" })),
});

interface ArtifactParams {
  action: ArtifactAction;
  id?: string;
  query?: string;
  offset?: number;
  limit?: number;
  maxMatches?: number;
  sourceKind?: string;
  format?: string;
}

type ArtifactResult = AgentToolResult<Record<string, unknown>>;

/**
 * The `artifact` tool: one read-only tool for stored artifacts (large web
 * pages, MCP results, imported documents). Every action only reads the store,
 * so one approval policy covers the tool.
 */
export function createArtifactTool(store: ToolArtifactStoreLike | undefined): AgentTool | undefined {
  if (!store) return undefined;
  return {
    name: ARTIFACT_TOOL_NAME,
    label: "Artifact",
    description:
      "Read-only access to stored artifacts (large web pages, MCP results, imported documents) by id. " +
      "action: list (recent artifacts), search (find text in one), read (a chunk by offset), " +
      "export (a bounded copy; use write to save it in the vault).",
    parameters: ArtifactParameters,
    execute: async (_id, params) => {
      const input = params as ArtifactParams;
      switch (normalizeAction(input.action)) {
        case "list":
          return listArtifacts(store, input);
        case "search":
          return searchArtifact(store, input);
        case "read":
          return readArtifact(store, input);
        case "export":
          return exportArtifact(store, input);
      }
    },
  };
}

function normalizeAction(value: unknown): ArtifactAction {
  if (typeof value === "string" && (ARTIFACT_ACTIONS as readonly string[]).includes(value)) return value as ArtifactAction;
  throw new Error(`artifact: action must be one of ${ARTIFACT_ACTIONS.join(", ")}.`);
}

function requiredId(params: ArtifactParams): string {
  const id = typeof params.id === "string" ? params.id.trim() : "";
  if (!id) throw new Error(`artifact: id is required for action "${params.action}".`);
  return id;
}

async function listArtifacts(store: ToolArtifactStoreLike, params: ArtifactParams): Promise<ArtifactResult> {
  const sourceKind = normalizeSourceKind(params.sourceKind);
  const limit = normalizeLimit(params.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const artifacts = (await store.listArtifacts?.()) ?? [];
  const visible = artifacts
    .filter((artifact) => !sourceKind || artifact.sourceKind === sourceKind)
    .slice(0, limit);
  return toolResult(formatArtifactList(visible, sourceKind), {
    action: "list",
    count: visible.length,
    sourceKind,
    limit,
    totalAvailable: artifacts.length,
  });
}

async function readArtifact(store: ToolArtifactStoreLike, params: ArtifactParams): Promise<ArtifactResult> {
  const read = await store.readArtifact(requiredId(params));
  const offset = normalizeOffset(params.offset, read.text.length);
  const limit = normalizeLimit(params.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
  const end = Math.min(read.text.length, offset + limit);
  const chunk = read.text.slice(offset, end);
  return untrustedToolResult(
    truncateToolOutput(formatArtifactRead(read, offset, end, chunk), MAX_READ_LIMIT + 1_000),
    {
      action: "read",
      artifactId: read.metadata.id,
      offset,
      limit,
      returnedChars: chunk.length,
      totalChars: read.text.length,
      truncated: end < read.text.length,
    },
    ARTIFACT_TOOL_NAME,
  );
}

async function searchArtifact(store: ToolArtifactStoreLike, params: ArtifactParams): Promise<ArtifactResult> {
  const id = requiredId(params);
  const query = typeof params.query === "string" ? params.query : "";
  if (!query.trim()) throw new Error('artifact: query is required for action "search".');
  const maxMatches = normalizeLimit(params.maxMatches, DEFAULT_SEARCH_MATCHES, MAX_SEARCH_MATCHES);
  const read = await store.readArtifact(id);
  const matches = findMatches(read.text, query, maxMatches);
  return untrustedToolResult(
    truncateToolOutput(formatArtifactSearch(read, query, matches)),
    {
      action: "search",
      artifactId: read.metadata.id,
      query,
      matches: matches.length,
      totalChars: read.text.length,
    },
    ARTIFACT_TOOL_NAME,
  );
}

async function exportArtifact(store: ToolArtifactStoreLike, params: ArtifactParams): Promise<ArtifactResult> {
  const read = await store.readArtifact(requiredId(params));
  const format = normalizeExportFormat(params.format);
  const limit = normalizeLimit(params.limit, DEFAULT_EXPORT_LIMIT, MAX_EXPORT_LIMIT);
  const truncated = read.text.length > limit;
  const payload = formatArtifactExport(read, format, limit);
  return untrustedToolResult(
    truncateToolOutput(payload, MAX_EXPORT_LIMIT + 2_000),
    {
      action: "export",
      artifactId: read.metadata.id,
      format,
      limit,
      returnedChars: Math.min(read.text.length, limit),
      totalChars: read.text.length,
      truncated,
    },
    ARTIFACT_TOOL_NAME,
  );
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
  throw new Error('artifact: format must be "markdown" or "json".');
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
  const next = end < read.text.length ? `\n\nNext chunk: call artifact with action "read" and offset ${end}.` : "";
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
    truncated ? `- truncated: true; call artifact (action "export") with a larger limit, or action "read" with offsets, for the rest.` : null,
    "",
    "## Content",
    "",
  ].filter((line): line is string => line !== null);
  return `${header.join("\n")}${text}`;
}
