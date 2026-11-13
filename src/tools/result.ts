import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { wrapToolOutputTruncated } from "./tool-output-wrapper";

/**
 * The one tool-result envelope. Plain output is bounded by each tool before it
 * gets here; untrusted output adds the marker wrapper and its truncation budget.
 */
export function toolResult<TDetails = Record<string, unknown>>(
  text: string,
  details: TDetails = {} as TDetails,
): AgentToolResult<TDetails> {
  return { content: [{ type: "text", text }], details };
}

export function untrustedToolResult<TDetails = Record<string, unknown>>(
  text: string,
  details: TDetails = {} as TDetails,
  toolName?: string,
): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text: wrapToolOutputTruncated(text, toolName) }],
    details,
  };
}
