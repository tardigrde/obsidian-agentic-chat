import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { MCP_TOOL_PREFIX, localMcpToolNames, type McpServerDiagnostic } from "../mcp/tools";
import { toolResult } from "../tools/result";

/**
 * Deferred tool loading.
 *
 * The model always gets a small core set of tools. Rarely used tools (every
 * MCP tool, `import_document`) are deferred:
 * the system prompt lists them, and `search_tools` loads the ones that match a
 * query. A loaded tool stays loaded for the rest of the session and is called
 * by its real name, so per-tool approval works the same as for core tools.
 */

export const SEARCH_TOOLS_TOOL_NAME = "search_tools";
export const SEARCH_TOOLS_MAX_RESULTS = 5;

const DEFERRED_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(["import_document"]);

export function isDeferredToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX) || DEFERRED_BUILTIN_TOOL_NAMES.has(name);
}

export class LoadedToolSet {
  private readonly names = new Set<string>();

  has(name: string): boolean {
    return this.names.has(name);
  }

  /** Add names; returns true when at least one was new. */
  add(names: Iterable<string>): boolean {
    let changed = false;
    for (const name of names) {
      if (this.names.has(name)) continue;
      this.names.add(name);
      changed = true;
    }
    return changed;
  }

  list(): string[] {
    return [...this.names];
  }

  clear(): void {
    this.names.clear();
  }

  /**
   * Rebuild the set from a saved transcript, so a reopened session keeps the
   * tools it loaded. A `search_tools` result names what it loaded; any result
   * of a deferred tool (also a failed direct call, which loads the tool) counts.
   */
  restoreFromMessages(messages: readonly AgentMessage[]): void {
    this.clear();
    for (const message of messages) {
      if (message.role !== "toolResult") continue;
      if (message.toolName === SEARCH_TOOLS_TOOL_NAME) {
        this.add(loadedNamesFromDetails(message.details));
      } else if (isDeferredToolName(message.toolName)) {
        this.add([message.toolName]);
      }
    }
  }
}

function loadedNamesFromDetails(details: unknown): string[] {
  if (!details || typeof details !== "object") return [];
  const loaded = (details as { loaded?: unknown }).loaded;
  return Array.isArray(loaded) ? loaded.filter((name): name is string => typeof name === "string") : [];
}

/** Split all tools into the set sent to the model and the deferred catalog. */
export function partitionTools(
  tools: readonly AgentTool[],
  loaded: LoadedToolSet,
): { active: AgentTool[]; deferred: AgentTool[] } {
  const active: AgentTool[] = [];
  const deferred: AgentTool[] = [];
  for (const tool of tools) {
    if (!isDeferredToolName(tool.name)) active.push(tool);
    else if (loaded.has(tool.name)) active.push(tool);
    else deferred.push(tool);
  }
  return { active, deferred };
}

const SearchToolsParameters = Type.Object({
  query: Type.String({ minLength: 1, description: "what the tool must do, or its name" }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: SEARCH_TOOLS_MAX_RESULTS,
      description: `max tools to load (default ${SEARCH_TOOLS_MAX_RESULTS})`,
    }),
  ),
});

export interface SearchToolsOptions {
  /** The deferred tools that are not loaded yet. */
  getDeferredTools: () => readonly AgentTool[];
  loaded: LoadedToolSet;
}

export function createSearchToolsTool(options: SearchToolsOptions): AgentTool<typeof SearchToolsParameters> {
  return {
    name: SEARCH_TOOLS_TOOL_NAME,
    label: "Search tools",
    description:
      "Find and load deferred tools (listed in the system prompt) by task or name. " +
      "Loaded tools are callable by their real names from your next step.",
    parameters: SearchToolsParameters,
    execute: async (_id, params) => {
      const candidates = options.getDeferredTools().filter((tool) => !options.loaded.has(tool.name));
      const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? SEARCH_TOOLS_MAX_RESULTS)), SEARCH_TOOLS_MAX_RESULTS);
      const matches = rankTools(candidates, params.query).slice(0, limit);
      const names = matches.map((match) => match.tool.name);
      options.loaded.add(names);
      if (matches.length === 0) {
        const available = candidates.map((tool) => tool.name);
        const text =
          available.length === 0
            ? `No deferred tools match "${params.query}". Every deferred tool is already loaded. Vault and web tools are active tools, not deferred, so they are not searched here: if they are available you already have them.`
            : `No deferred tools match "${params.query}". Try other words. Deferred tools: ${available.join(", ")}. Vault and web tools are active tools, not deferred, so they are not searched here.`;
        return toolResult(text, { query: params.query, loaded: [] });
      }
      const lines = matches.map((match) => `- ${match.tool.name}: ${firstSentence(match.tool.description ?? "")}`);
      const text = `Loaded ${matches.length} tool(s). Call them by name from your next step:\n${lines.join("\n")}`;
      return toolResult(text, { query: params.query, loaded: names });
    },
  };
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Name tokens count more than description words. */
const NAME_WEIGHT = 3;

export interface ToolMatch {
  tool: AgentTool;
  score: number;
}

export function rankTools(tools: readonly AgentTool[], query: string): ToolMatch[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0 || tools.length === 0) return [];
  const exact = query.trim().toLowerCase();
  const documents = tools.map((tool) => ({ tool, tokens: documentTokens(tool) }));
  const averageLength = documents.reduce((sum, doc) => sum + doc.tokens.length, 0) / documents.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const token of new Set(doc.tokens)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const matches: ToolMatch[] = [];
  for (const doc of documents) {
    const termFrequency = new Map<string, number>();
    for (const token of doc.tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const frequency = termFrequency.get(token) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const norm = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.tokens.length) / averageLength);
      score += idf * ((frequency * (BM25_K1 + 1)) / norm);
    }
    // An exact name (full or MCP-local) always wins.
    const name = doc.tool.name.toLowerCase();
    if (name === exact || localToolName(name) === exact) score += 1_000;
    if (score > 0) matches.push({ tool: doc.tool, score });
  }
  return matches.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
}

function documentTokens(tool: AgentTool): string[] {
  const nameTokens = tokenize(tool.name);
  const tokens: string[] = [];
  for (let i = 0; i < NAME_WEIGHT; i += 1) tokens.push(...nameTokens);
  tokens.push(...tokenize(tool.label ?? ""), ...tokenize(tool.description ?? ""));
  const properties = (tool.parameters as { properties?: Record<string, { description?: unknown }> } | undefined)?.properties;
  for (const [key, schema] of Object.entries(properties ?? {})) {
    tokens.push(...tokenize(key));
    if (typeof schema?.description === "string") tokens.push(...tokenize(schema.description));
  }
  return tokens;
}

const STOP_WORDS = new Set(["a", "an", "and", "the", "to", "of", "for", "in", "on", "by", "or", "is", "it", "with", "from", "mcp"]);

export function tokenize(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
    .map(stem);
}

/** A tiny plural stem, so "documents" finds "document". */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function localToolName(name: string): string {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return name;
  const parts = name.slice(MCP_TOOL_PREFIX.length).split("__");
  return parts.length > 1 ? parts.slice(1).join("__") : name;
}

function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? trimmed : trimmed.slice(0, end + 1);
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/**
 * The model-visible list of deferred tools: one line per built-in deferred
 * tool, and one line per MCP server (not per MCP tool), so a large MCP setup
 * does not grow the prompt. Pass the whole deferred catalog, loaded or not, so
 * the prompt stays the same when a tool loads.
 */
export function formatDeferredToolsOverlay(
  catalog: readonly AgentTool[],
  mcpServers: readonly McpServerDiagnostic[] = [],
): string {
  const deferred = catalog.filter((tool) => isDeferredToolName(tool.name));
  if (deferred.length === 0) return "";
  const builtins = deferred.filter((tool) => !tool.name.startsWith(MCP_TOOL_PREFIX));
  const mcpNames = new Set(deferred.filter((tool) => tool.name.startsWith(MCP_TOOL_PREFIX)).map((tool) => tool.name));
  const lines = builtins.map((tool) => `- ${tool.name}: ${firstSentence(tool.description ?? "")}`);
  const listed = new Set<string>();
  for (const server of mcpServers) {
    // Same sanitizing and de-duplication as the exposed tool names.
    const names = localMcpToolNames(server.serverId, server.toolNames).filter((name) => mcpNames.has(name));
    if (names.length === 0) continue;
    for (const name of names) listed.add(name);
    lines.push(`- MCP server "${sanitizeServerName(server.serverName)}": ${names.length} tool(s)`);
  }
  const unlisted = [...mcpNames].filter((name) => !listed.has(name)).length;
  if (unlisted > 0) lines.push(`- Other MCP tools: ${unlisted}`);
  return [
    "## Deferred tools",
    "",
    "These tools are deferred: they are not in your tool list until you load them. Call `search_tools` with a " +
      "short description of the task (or a tool name) to load the best matches, then call them by name in your " +
      "next step. A loaded tool stays loaded for the rest of the session.",
    "",
    ...lines,
  ].join("\n");
}

function sanitizeServerName(name: string): string {
  return name.replace(/[\r\n"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}
