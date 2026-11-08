import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import type { RequestCostEstimate } from "./cost";
import { sumSessionUsage } from "./session-usage";
import { compactionCount, contextReadout, estimateNextCostReadout, expectedOutputTokens, type ContextReadout } from "./readouts";

export interface AgentServiceReadoutInput {
  messages: AgentMessage[];
  model: Model<Api> | undefined;
  settings: AgenticChatSettings;
  systemPrompt: string;
  tools: readonly AgentTool[];
  subagentUsage: Usage;
}

type AgentContextReadoutInput = Pick<
  AgentServiceReadoutInput,
  "messages" | "model" | "settings" | "systemPrompt" | "tools"
>;
type AgentSessionUsageReadoutInput = Pick<AgentServiceReadoutInput, "messages" | "subagentUsage">;
type AgentNextCostReadoutInput = Pick<
  AgentServiceReadoutInput,
  "messages" | "model" | "settings" | "systemPrompt" | "tools"
>;

export function agentContextReadout(input: AgentContextReadoutInput): ContextReadout | undefined {
  return contextReadout({
    messages: input.messages,
    contextWindow: input.model?.contextWindow ?? 0,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    reserveTokens: expectedOutputTokens(input.settings),
  });
}

export function agentContextFraction(input: AgentContextReadoutInput): number | undefined {
  return agentContextReadout(input)?.fraction;
}

export function agentSessionUsage(input: AgentSessionUsageReadoutInput): Usage {
  return sumSessionUsage(input.messages, input.subagentUsage);
}

export function agentCompactionCount(input: Pick<AgentServiceReadoutInput, "messages">): number {
  return compactionCount(input.messages);
}

export function agentNextCostEstimate(input: AgentNextCostReadoutInput): RequestCostEstimate | undefined {
  return estimateNextCostReadout({
    messages: input.messages,
    model: input.model,
    settings: input.settings,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
  });
}

export function agentSupportsImages(model: Model<Api> | undefined): boolean {
  return !!model?.input?.includes("image");
}
