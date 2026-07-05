import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import { estimateContextUsage, isSummaryMessage } from "./compaction";
import {
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  estimateNextRequestCost,
  hasPricing,
  type RequestCostEstimate,
} from "./cost";

export function contextFraction(messages: AgentMessage[], contextWindow: number): number | undefined {
  if (contextWindow <= 0) return undefined;
  const tokens = estimateContextUsage(messages);
  if (tokens <= 0) return undefined;
  return Math.min(tokens / contextWindow, 1);
}

export function compactionCount(messages: AgentMessage[]): number {
  return messages.filter(isSummaryMessage).length;
}

export function estimateNextCostReadout(params: {
  messages: AgentMessage[];
  model: Model<Api> | undefined;
  settings: Pick<AgenticChatSettings, "maxTokens">;
  systemPrompt: string;
}): RequestCostEstimate | undefined {
  const { messages, model, settings, systemPrompt } = params;
  if (!model || !hasPricing(model.cost)) return undefined;
  const expectedOutput = settings.maxTokens > 0 ? settings.maxTokens : DEFAULT_EXPECTED_OUTPUT_TOKENS;
  return estimateNextRequestCost(messages, model.cost, expectedOutput, systemPrompt);
}
