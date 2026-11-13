import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { wrapToolOutputTruncated } from "./tool-output-wrapper";

/** One text block for a message or tool result. */
export function textContent(text: string): TextContent {
  return { type: "text", text };
}

/**
 * The one tool-result envelope. Plain output is bounded by each tool before it
 * gets here; untrusted output adds the marker wrapper and its truncation budget.
 */
export function toolResult<TDetails = Record<string, unknown>>(
  text: string,
  details: TDetails = {} as TDetails,
): AgentToolResult<TDetails> {
  return { content: [textContent(text)], details };
}

export function untrustedToolResult<TDetails = Record<string, unknown>>(
  text: string,
  details: TDetails = {} as TDetails,
  toolName?: string,
): AgentToolResult<TDetails> {
  return {
    content: [textContent(wrapToolOutputTruncated(text, toolName))],
    details,
  };
}
