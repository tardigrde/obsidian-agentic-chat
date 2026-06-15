import { estimateContextTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

/** Per-million-token pricing as carried on a pi-ai model. */
type ModelCost = Model<"openai-completions">["cost"];

/** A pre-send estimate of the next request's size and cost. */
export interface RequestCostEstimate {
  /** Estimated input (context) tokens for the next request. */
  inputTokens: number;
  /** Assumed output tokens for the next request. */
  outputTokens: number;
  /** Estimated USD cost; 0 when the model has no pricing. */
  usd: number;
}

/** Assumed output tokens when the user hasn't set an explicit max. */
export const DEFAULT_EXPECTED_OUTPUT_TOKENS = 1_000;

/** Estimate one request's USD cost from token counts and per-million pricing. */
export function estimateRequestCost(params: {
  inputTokens: number;
  outputTokens: number;
  cost: ModelCost | undefined;
}): RequestCostEstimate {
  const { inputTokens, outputTokens, cost } = params;
  const inRate = cost?.input ?? 0;
  const outRate = cost?.output ?? 0;
  const usd = (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
  return { inputTokens, outputTokens, usd };
}

/**
 * Estimate the next request's cost from the current transcript plus an assumed
 * output. Input tokens reuse pi's context estimate (provider usage when known,
 * a char heuristic otherwise).
 *
 * `systemPromptText` is folded in only when there's no prior assistant usage to
 * anchor the estimate: once a turn has run, the provider's reported input tokens
 * already include the system prompt, so adding it again would double-count it.
 */
export function estimateNextRequestCost(
  messages: AgentMessage[],
  cost: ModelCost | undefined,
  expectedOutputTokens: number,
  systemPromptText?: string,
): RequestCostEstimate {
  const context = estimateContextTokens(messages);
  let inputTokens = context.tokens;
  if (context.lastUsageIndex === null && systemPromptText) {
    inputTokens += Math.ceil(systemPromptText.length / 4);
  }
  return estimateRequestCost({ inputTokens, outputTokens: expectedOutputTokens, cost });
}

/** True when the model has real pricing, so a cost estimate is meaningful (not just $0). */
export function hasPricing(cost: ModelCost | undefined): boolean {
  return !!cost && ((cost.input ?? 0) > 0 || (cost.output ?? 0) > 0);
}
