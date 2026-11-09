import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import type { RequestCostEstimate } from "./cost";
import { sumSessionUsage } from "./session-usage";
import {
  compactionCount,
  contextOverheadTokens,
  contextReadout,
  estimateNextCostReadout,
  expectedOutputTokens,
  type ContextOverheadCounter,
  type ContextReadout,
} from "./readouts";

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

export function agentContextReadout(
  input: AgentContextReadoutInput,
  counter?: ContextOverheadCounter,
): ContextReadout | undefined {
  return contextReadout({
    messages: input.messages,
    contextWindow: input.model?.contextWindow ?? 0,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    reserveTokens: expectedOutputTokens(input.settings),
  }, counter);
}

export function agentContextFraction(
  input: AgentContextReadoutInput,
  counter?: ContextOverheadCounter,
): number | undefined {
  return agentContextReadout(input, counter)?.fraction;
}

/** Non-transcript load the compaction threshold adds, measured exactly as the readout does. */
export function agentContextOverheadTokens(
  input: Pick<AgentServiceReadoutInput, "settings" | "systemPrompt" | "tools">,
  counter?: ContextOverheadCounter,
): number {
  return contextOverheadTokens({
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    reserveTokens: expectedOutputTokens(input.settings),
  }, counter);
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
