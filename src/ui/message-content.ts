import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

/** A flattened tool result, keyed elsewhere by its tool-call id. */
export interface ToolResultLite {
  text: string;
  isError: boolean;
}

/** Index every `toolResult` message by its originating tool-call id. */
export function collectToolResults(messages: AgentMessage[]): Map<string, ToolResultLite> {
  const map = new Map<string, ToolResultLite>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      map.set(message.toolCallId, { text: toolResultText(message), isError: message.isError });
    }
  }
  return map;
}

function contentBlocks(message: AgentMessage): Array<Record<string, unknown>> {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

/** Concatenated visible text of a message (string content or `text` blocks). */
export function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return contentBlocks(message)
    .filter((block) => block.type === "text")
    .map((block) => stringFromPrimitive(block.text))
    .join("");
}

/** Concatenated reasoning/thinking text of an assistant message. */
export function thinkingText(message: AgentMessage): string {
  return contentBlocks(message)
    .filter((block) => block.type === "thinking")
    .map((block) => stringFromPrimitive(block.thinking))
    .join("");
}

export interface ToolCallLite {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool-call blocks contained in an assistant message. */
export function toolCalls(message: AgentMessage): ToolCallLite[] {
  return contentBlocks(message)
    .filter((block) => block.type === "toolCall")
    .map((block) => ({
      id: stringFromPrimitive(block.id),
      name: stringFromPrimitive(block.name),
      arguments: (block.arguments as Record<string, unknown>) ?? {},
    }));
}

/** Flatten a tool result's content into plain text. */
export function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => (block as { type?: unknown }).type === "text")
    .map((block) => stringFromPrimitive((block as { text?: unknown }).text))
    .join("\n");
}

function stringFromPrimitive(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString();
  return "";
}

/** A message's usage, but only when it recorded real token counts. */
export function assistantUsage(message: AgentMessage): Usage | undefined {
  const usage = (message as { usage?: Usage }).usage;
  return usage && usage.totalTokens > 0 ? usage : undefined;
}

/**
 * Text of the most recent user message, used to power "retry". Returns undefined
 * when no user turn exists. Note this is the raw prompt as sent (it may include an
 * attachment `<context>` preamble); callers that re-send get an identical turn.
 */
export function lastUserText(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") {
      const text = messageText(message);
      if (text.trim()) return text;
    }
  }
  return undefined;
}
