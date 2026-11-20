import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { AgenticChatSettings } from "../settings-schema";
import { isPricingUnknown } from "../llm/pricing-cache";
import { estimateContextUsage, isSummaryMessage } from "./compaction";
import {
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  estimateRequestCost,
  hasPricing,
  type RequestCostEstimate,
} from "./cost";
import { estimateToolDefinitionTokens } from "./tool-schema-tokens";

export interface ContextLoadInput {
  messages: AgentMessage[];
  /** Composed system prompt (base prompt, overlays, and loaded skill bodies). */
  systemPrompt?: string;
  /** Tools the model can currently call (loaded tools only; deferred tools are not sent). */
  tools?: readonly AgentTool[];
  /** Tokens held back for the model's response. */
  reserveTokens?: number;
  /** Parts of the system prompt and tool catalog, for the breakdown. */
  parts?: ContextLoadParts;
}

/** What the system prompt and the tool catalog hold, for the context breakdown. */
export interface ContextLoadParts {
  /** The vault's standing-instructions text (AGENTS.md) inside the system prompt. */
  instructions?: string;
  /** The loaded-skills section inside the system prompt. */
  skills?: string;
  /** Deferred tools in the catalog (MCP and others) that are not loaded, so not sent. */
  deferredNotLoaded?: number;
}

/** The finer split of the estimate that the context tooltip shows. */
export interface ContextBreakdown {
  instructionsTokens: number;
  skillsTokens: number;
  builtinToolTokens: number;
  mcpToolTokens: number;
  /** MCP servers with at least one loaded (sent) tool. */
  mcpServers: number;
  /** Deferred tools that are not sent: a count, not tokens. */
  deferredNotLoaded: number;
  /** The share of the transcript that is tool results. */
  toolResultTokens: number;
}

/** Section-by-section token accounting for the context the next request will send. */
export interface ContextLoadEstimate {
  /** Estimated tokens in the conversation transcript. */
  transcriptTokens: number;
  /** Estimated tokens in the composed system prompt, including loaded skill bodies. */
  systemPromptTokens: number;
  /** Estimated tokens in the active tool schemas. */
  toolSchemaTokens: number;
  /** Tokens held back for the model's response. */
  reserveTokens: number;
  /** Input tokens for the next request: transcript + system prompt + tool schemas. */
  inputTokens: number;
  /** Context-window load: input tokens + response reserve. */
  totalTokens: number;
  /** The finer split, when the caller passed `parts`. */
  breakdown?: ContextBreakdown;
}

export interface ContextReadout {
  /** Fraction (0-1) of the model's context window the next request will occupy. */
  fraction: number;
  contextWindow: number;
  load: ContextLoadEstimate;
}

/** Expected output tokens for the next request: the configured max, else a fixed reserve. */
export function expectedOutputTokens(settings: Pick<AgenticChatSettings, "maxTokens">): number {
  return settings.maxTokens > 0 ? settings.maxTokens : DEFAULT_EXPECTED_OUTPUT_TOKENS;
}

/** Measures the non-transcript sections of a request: system prompt and tool schemas. */
export interface ContextOverheadCounter {
  systemPromptTokens(systemPrompt: string | undefined): number;
  toolSchemaTokens(tools: readonly AgentTool[] | undefined): number;
  /** Schema tokens of the MCP tools among `tools`; cached on the array like toolSchemaTokens. */
  mcpToolSchemaTokens?(tools: readonly AgentTool[] | undefined): number;
}

const MCP_PREFIX = "mcp__";

function mcpTools(tools: readonly AgentTool[] | undefined): AgentTool[] {
  return (tools ?? []).filter((tool) => tool.name.startsWith(MCP_PREFIX));
}

const uncachedOverhead: ContextOverheadCounter = {
  systemPromptTokens: (systemPrompt) => (systemPrompt ? estimateTextTokens(systemPrompt) : 0),
  toolSchemaTokens: (tools) => (tools && tools.length > 0 ? estimateToolDefinitionTokens(tools) : 0),
};

/**
 * Remembers the last system prompt and tool array it measured. The readout runs
 * on every UI event; with unchanged inputs it must not re-serialize every tool
 * schema. Keys are the prompt string and the tools array identity (pi copies the
 * array on every assignment, so a changed tool set is always a new array).
 */
export class CachedContextOverheadCounter implements ContextOverheadCounter {
  private prompt: { key: string; tokens: number } | undefined;
  private tools: { key: readonly AgentTool[]; tokens: number } | undefined;
  private mcp: { key: readonly AgentTool[]; tokens: number } | undefined;

  constructor(private readonly countToolTokens: (tools: readonly AgentTool[]) => number = estimateToolDefinitionTokens) {}

  systemPromptTokens(systemPrompt: string | undefined): number {
    if (!systemPrompt) return 0;
    if (this.prompt?.key !== systemPrompt) {
      this.prompt = { key: systemPrompt, tokens: estimateTextTokens(systemPrompt) };
    }
    return this.prompt.tokens;
  }

  toolSchemaTokens(tools: readonly AgentTool[] | undefined): number {
    if (!tools || tools.length === 0) return 0;
    if (this.tools?.key !== tools) {
      this.tools = { key: tools, tokens: this.countToolTokens(tools) };
    }
    return this.tools.tokens;
  }

  mcpToolSchemaTokens(tools: readonly AgentTool[] | undefined): number {
    if (!tools || tools.length === 0) return 0;
    if (this.mcp?.key !== tools) {
      const mcp = mcpTools(tools);
      this.mcp = { key: tools, tokens: mcp.length > 0 ? this.countToolTokens(mcp) : 0 };
    }
    return this.mcp.tokens;
  }
}

/**
 * Tokens every request carries besides the transcript: system prompt, tool
 * schemas, and the response reserve. Compaction adds this to the transcript so
 * its threshold check uses the same total as the context bar.
 */
export function contextOverheadTokens(
  input: Omit<ContextLoadInput, "messages">,
  counter: ContextOverheadCounter = uncachedOverhead,
): number {
  const load = estimateContextLoad({ ...input, messages: [] }, counter);
  return load.totalTokens;
}

/**
 * Estimate the full context load for the next request. This is the single source
 * of truth for the context fraction, the next-cost readout, and the compaction
 * threshold: every section is measured once here, and no caller repeats
 * character math.
 */
export function estimateContextLoad(
  input: ContextLoadInput,
  counter: ContextOverheadCounter = uncachedOverhead,
): ContextLoadEstimate {
  const transcriptTokens = estimateContextUsage(input.messages);
  const systemPromptTokens = counter.systemPromptTokens(input.systemPrompt);
  const toolSchemaTokens = counter.toolSchemaTokens(input.tools);
  const reserveTokens = Math.max(0, Math.trunc(input.reserveTokens ?? 0));
  const inputTokens = transcriptTokens + systemPromptTokens + toolSchemaTokens;
  const load: ContextLoadEstimate = {
    transcriptTokens,
    systemPromptTokens,
    toolSchemaTokens,
    reserveTokens,
    inputTokens,
    totalTokens: inputTokens + reserveTokens,
  };
  if (input.parts) load.breakdown = contextBreakdown(input, load, counter);
  return load;
}

/** Split the estimate finer: instructions and skills, built-in and MCP tools, tool results. */
function contextBreakdown(input: ContextLoadInput, load: ContextLoadEstimate, counter: ContextOverheadCounter): ContextBreakdown {
  const parts = input.parts ?? {};
  const instructionsTokens = Math.min(parts.instructions ? estimateTextTokens(parts.instructions) : 0, load.systemPromptTokens);
  const skillsTokens = Math.min(parts.skills ? estimateTextTokens(parts.skills) : 0, load.systemPromptTokens - instructionsTokens);
  const mcp = mcpTools(input.tools);
  const mcpToolTokens = Math.min(
    counter.mcpToolSchemaTokens?.(input.tools) ?? (mcp.length > 0 ? estimateToolDefinitionTokens(mcp) : 0),
    load.toolSchemaTokens,
  );
  const servers = new Set(mcp.map((tool) => tool.name.split("__")[1]).filter(Boolean));
  const toolResults = input.messages.filter((message) => message.role === "toolResult");
  return {
    instructionsTokens,
    skillsTokens,
    builtinToolTokens: load.toolSchemaTokens - mcpToolTokens,
    mcpToolTokens,
    mcpServers: servers.size,
    deferredNotLoaded: Math.max(0, Math.trunc(parts.deferredNotLoaded ?? 0)),
    toolResultTokens: Math.min(estimateContextUsage(toolResults), load.transcriptTokens),
  };
}

export function contextReadout(
  input: ContextLoadInput & { contextWindow: number },
  counter?: ContextOverheadCounter,
): ContextReadout | undefined {
  if (!Number.isFinite(input.contextWindow) || input.contextWindow <= 0) return undefined;
  const load = estimateContextLoad(input, counter);
  // Keep the readout hidden until there is a transcript to report; the full
  // request overhead alone is not a useful signal on an untouched session.
  if (load.transcriptTokens <= 0) return undefined;
  return {
    fraction: Math.min(load.totalTokens / input.contextWindow, 1),
    contextWindow: input.contextWindow,
    load,
  };
}

export function contextFraction(
  messages: AgentMessage[],
  contextWindow: number,
  overhead: Omit<ContextLoadInput, "messages"> = {},
): number | undefined {
  return contextReadout({ messages, contextWindow, ...overhead })?.fraction;
}

export function compactionCount(messages: AgentMessage[]): number {
  return messages.filter(isSummaryMessage).length;
}

export function estimateNextCostReadout(params: {
  messages: AgentMessage[];
  model: Model<Api> | undefined;
  settings: Pick<AgenticChatSettings, "maxTokens">;
  systemPrompt: string;
  tools?: readonly AgentTool[];
}): RequestCostEstimate | undefined {
  const { messages, model, settings, systemPrompt, tools } = params;
  if (!model) return undefined;
  const load = estimateContextLoad({
    messages,
    systemPrompt,
    tools,
    reserveTokens: expectedOutputTokens(settings),
  });
  const estimate = estimateRequestCost({
    inputTokens: load.inputTokens,
    outputTokens: load.reserveTokens,
    cost: model.cost,
  });
  if (!hasPricing(model.cost)) {
    // Ollama is known-free (provider === "ollama"); others with zero cost may be unknown.
    if (model.provider !== "ollama" && isPricingUnknown(model.provider as "openrouter" | "openai-compatible", model.id)) {
      return { ...estimate, isUnknown: true };
    }
    return undefined;
  }
  return estimate;
}
