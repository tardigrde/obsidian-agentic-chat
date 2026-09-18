import type { App, DataAdapter } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { PLUGIN_ID } from "../constants";
import type { JevTransport } from "../agent/jev-client";
import { rerankMemoryMatches } from "../memory/jev-rerank";
import type { AgenticChatSettings } from "../settings";
import {
  formatMemorySearchResponse,
  loadMemoryRecords,
  memoryCitations,
  MEMORY_SCOPES,
  searchMemories,
  type MemoryKind,
  type MemoryScope,
} from "../memory/memory";

const SearchMemoryParameters = Type.Object({
  query: Type.String({ description: "search text; memories are never injected unless searched" }),
  kind: Type.Optional(Type.String({ description: "preference|fact|instruction|summary" })),
  scope: Type.Optional(Type.String({ description: "global|vault" })),
  maxResults: Type.Optional(Type.Number({ description: "max results (default 8)" })),
});

export interface MemoryToolsOptions {
  adapter?: DataAdapter;
  memoryPath?: string;
  /**
   * Opt-in Jev rerank plumbing. `settings` carries `settings.jev`
   * (key arrives via secretStorage hydration); `transport` is a test seam
   * (production uses Obsidian requestUrl).
   */
  jev?: {
    settings: AgenticChatSettings;
    transport?: JevTransport;
    resolveApiKey?: () => Promise<string | undefined> | string | undefined;
  };
}

export function createMemoryTools(app: App, options: MemoryToolsOptions = {}): AgentTool[] {
  return [createSearchMemoryTool(options.adapter ?? app.vault.adapter, options.memoryPath ?? memoryPathForApp(app), options.jev)];
}

function createSearchMemoryTool(
  adapter: DataAdapter | undefined,
  memoryPath: string,
  jev?: MemoryToolsOptions["jev"],
): AgentTool<typeof SearchMemoryParameters> {
  return {
    name: "search_memory",
    label: "Search memory",
    description:
      "Search stored long-term memories and return matches with citations. " +
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
      // Opt-in Jev rerank (fail-soft to lexical order). Reranks the top
      // candidates and keeps the tail lexical; vault-scoped memories are
      // pinned unless includeVaultScope is set (see jev-rerank.ts).
      let matches = response.matches;
      let jevReranked = false;
      if (jev) {
        try {
          const guard = jev.settings.jev?.rerank;
          if (guard?.enabled && guard.allowEgress) {
            let apiKey: string | undefined;
            try {
              apiKey = await jev.resolveApiKey?.();
            } catch {
              apiKey = undefined;
            }
            apiKey = apiKey?.trim() || jev.settings.jev?.apiKey?.trim() || undefined;
            if (apiKey) {
              const reranked = await rerankMemoryMatches(query, response.matches, {
                enabled: true,
                apiKey,
                allowEgress: guard.allowEgress,
                includeVaultScope: guard.includeVaultScope,
                timeoutMs: guard.timeoutMs,
                transport: jev.transport,
              });
              if (reranked.source === "jev") {
                matches = reranked.matches;
                jevReranked = true;
              }
            }
          }
        } catch {
          // Fail-open: lexical order stands.
        }
      }
      const ranked = { ...response, matches };
      return {
        content: [{ type: "text", text: formatMemorySearchResponse({ query }, ranked) }],
        details: {
          memoryPath,
          query,
          returned: matches.length,
          totalMatches: response.totalMatches,
          filteredCount: response.filteredCount,
          disabledCount: response.disabledCount,
          citations: memoryCitations(matches),
          memoryIds: matches.map((match) => match.record.id),
          jevReranked,
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
  return typeof value === "string" && MEMORY_SCOPES.has(value as MemoryScope) ? (value as MemoryScope) : undefined;
}
