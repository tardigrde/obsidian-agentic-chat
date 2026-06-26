import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import { isSummaryMessage } from "./compaction";
import {
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  estimateNextRequestCost,
  hasPricing,
  type RequestCostEstimate,
} from "./cost";

export function contextFraction(messages: AgentMessage[], contextWindow: number): number | undefined {
  if (contextWindow <= 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const input = message.role === "assistant" ? message.usage?.input ?? 0 : 0;
    if (input > 0) return Math.min(input / contextWindow, 1);
  }
  return undefined;
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
