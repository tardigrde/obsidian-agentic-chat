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
import { estimateToolDefinitionTokens } from "./tool-budget";

export interface ContextLoadInput {
  messages: AgentMessage[];
  /** Composed system prompt (base prompt, overlays, and loaded skill bodies). */
  systemPrompt?: string;
  /** Tools the model can currently call (after the tool budget runs). */
  tools?: readonly AgentTool[];
  /** Tokens held back for the model's response. */
  reserveTokens?: number;
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
  return {
    transcriptTokens,
    systemPromptTokens,
    toolSchemaTokens,
    reserveTokens,
    inputTokens,
    totalTokens: inputTokens + reserveTokens,
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
