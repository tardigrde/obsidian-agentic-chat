import type { App, DataAdapter } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { PLUGIN_ID } from "../constants";
import {
  formatMemorySearchResponse,
  loadMemoryRecords,
  memoryCitations,
  searchMemories,
  type MemoryKind,
  type MemoryScope,
} from "../memory/memory";

const SearchMemoryParameters = Type.Object({
  query: Type.String({ description: "Memory query. Required; memories are never injected automatically." }),
  kind: Type.Optional(Type.String({ description: "Optional memory kind: preference, fact, instruction, or summary." })),
  scope: Type.Optional(Type.String({ description: "Optional scope: global or vault. Project memories are filtered until project context is active." })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum memories to return. Defaults to 8." })),
});

export interface MemoryToolsOptions {
  adapter?: DataAdapter;
  memoryPath?: string;
}

export function createMemoryTools(app: App, options: MemoryToolsOptions = {}): AgentTool[] {
  return [createSearchMemoryTool(options.adapter ?? app.vault.adapter, options.memoryPath ?? memoryPathForApp(app))];
}

function createSearchMemoryTool(
  adapter: DataAdapter | undefined,
  memoryPath: string,
): AgentTool<typeof SearchMemoryParameters> {
  return {
    name: "search_memory",
    label: "Search memory",
    description:
      "Explicitly search plugin-managed long-term memories and return matching memories with source citations when available. " +
      "Memories are never added to context unless this tool is called.",
    parameters: SearchMemoryParameters,
    execute: async (_id, params) => {
      const query = String(params.query ?? "").trim();
      if (!query) throw new Error("query is required.");
      const records = await loadMemoryRecords(adapter, memoryPath);
      const response = searchMemories(
        {
          query,
          kind: parseKind(params.kind),
          scope: parseScope(params.scope),
          maxResults: normalizeLimit(params.maxResults),
        },
        {
          records,
          allowedScopes: ["global", "vault"],
        },
      );
      return {
        content: [{ type: "text", text: formatMemorySearchResponse({ query }, response) }],
        details: {
          memoryPath,
          query,
          returned: response.matches.length,
          totalMatches: response.totalMatches,
          filteredCount: response.filteredCount,
          disabledCount: response.disabledCount,
          citations: memoryCitations(response.matches),
          memoryIds: response.matches.map((match) => match.record.id),
        },
      };
    },
  };
}

export function memoryPathForApp(app: App): string {
  return `${app.vault.configDir}/plugins/${PLUGIN_ID}/memory/memories.jsonl`;
}

function normalizeLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(1, Math.trunc(value)), 25);
}

function parseKind(value: unknown): MemoryKind | undefined {
  return value === "preference" || value === "fact" || value === "instruction" || value === "summary"
    ? value
    : undefined;
}

function parseScope(value: unknown): MemoryScope | undefined {
  return value === "global" || value === "vault" ? value : undefined;
}
