import type { AgentTool } from "@earendil-works/pi-agent-core";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";

/**
 * Estimate the tokens the model-visible tool declarations cost. Uses pi-ai's
 * text ratio (3.5 chars per token), the same ratio as every other context
 * estimate, so the context bar sums one unit.
 */
export function estimateToolDefinitionTokens(tools: readonly Pick<AgentTool, "name" | "description" | "parameters">[]): number {
  if (tools.length === 0) return 0;
  const modelVisible = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? {},
  }));
  return estimateTextTokens(JSON.stringify(modelVisible));
}
