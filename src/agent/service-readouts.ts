import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import type { RequestCostEstimate } from "./cost";
import { sumSessionUsage } from "./session-usage";
import { compactionCount, contextFraction, estimateNextCostReadout } from "./readouts";

export interface AgentServiceReadoutInput {
  messages: AgentMessage[];
  model: Model<Api> | undefined;
  settings: AgenticChatSettings;
  systemPrompt: string;
  subagentUsage: Usage;
}

type AgentContextReadoutInput = Pick<AgentServiceReadoutInput, "messages" | "model">;
type AgentSessionUsageReadoutInput = Pick<AgentServiceReadoutInput, "messages" | "subagentUsage">;
type AgentNextCostReadoutInput = Pick<AgentServiceReadoutInput, "messages" | "model" | "settings" | "systemPrompt">;

export function agentContextFraction(input: AgentContextReadoutInput): number | undefined {
  return contextFraction(input.messages, input.model?.contextWindow ?? 0);
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
  });
}

export function agentSupportsImages(model: Model<Api> | undefined): boolean {
  return !!model?.input?.includes("image");
}
