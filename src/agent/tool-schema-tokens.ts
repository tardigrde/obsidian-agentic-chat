import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * pi-ai's text ratio (`@earendil-works/pi-ai/utils/estimate`), the same ratio
 * as every other context estimate, so the context bar sums one unit. Kept as a
 * local constant: `scripts/run-agentic-evals.ts` loads this file through tsx as
 * CommonJS, and pi-ai exports `./utils/*` for `import` only.
 * `test/tool-schema-tokens.test.ts` pins it to pi-ai's function.
 */
export const TOOL_SCHEMA_CHARS_PER_TOKEN = 3.5;

/** Estimate the tokens the model-visible tool declarations cost. */
export function estimateToolDefinitionTokens(tools: readonly Pick<AgentTool, "name" | "description" | "parameters">[]): number {
  if (tools.length === 0) return 0;
  const modelVisible = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? {},
  }));
  return Math.ceil(JSON.stringify(modelVisible).length / TOOL_SCHEMA_CHARS_PER_TOKEN);
}
