import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { truncateToolOutput } from "../vault/truncate";
import type { ToolArtifactStoreLike, ToolArtifactReadResult } from "./tool-artifact-store";

const DEFAULT_READ_LIMIT = 12_000;
const MAX_READ_LIMIT = 30_000;
const DEFAULT_SEARCH_MATCHES = 10;
const MAX_SEARCH_MATCHES = 50;
const SEARCH_CONTEXT_CHARS = 220;

export function createToolArtifactTools(store: ToolArtifactStoreLike | undefined): AgentTool[] {
  if (!store) return [];
  return [createReadArtifactTool(store), createSearchArtifactTool(store)];
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

function normalizeOffset(value: number | undefined, totalChars: number): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), totalChars);
}

function normalizeLimit(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.min(Math.max(1, Math.trunc(value)), maxValue);
}

function formatArtifactRead(read: ToolArtifactReadResult, offset: number, end: number, chunk: string): string {
  const range = chunk.length > 0 ? `${offset}-${end - 1}` : `${offset}-${offset}`;
  const header = [
    `Artifact ${read.metadata.id}`,
    `Label: ${read.metadata.label}`,
    `Source tool: ${read.metadata.sourceToolName}`,
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
    if (text.charCodeAt(index) === 10) line += 1;
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
    `Artifact ${read.metadata.id}`,
    `Label: ${read.metadata.label}`,
    `Source tool: ${read.metadata.sourceToolName}`,
    `Query: ${query}`,
  ].join("\n");
  if (matches.length === 0) return `${header}\n\nNo matches.`;
  const rows = matches.map((match, index) => `${index + 1}. offset ${match.offset}, line ${match.line}: ${match.snippet}`);
  return `${header}\n\n${rows.join("\n")}`;
}
