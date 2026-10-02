import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * pi 1.0.0 made the system prompt part of the agent transcript: `Agent` seeds a
 * leading `system` message from `initialState.systemPrompt` and folds tool
 * declarations into it, and `agent.state.messages` now includes it.
 *
 * The plugin's own concept of a conversation is narrower — user prompts,
 * assistant turns, and tool results. The pi-owned system message is runtime
 * context: it embeds the full system prompt and every tool schema, and `Agent`
 * only seeds a fresh one when the transcript does not already start with a
 * system message. Persisting it into session JSONL would therefore bloat every
 * session file and, worse, make a rehydrated session replay a stale prompt
 * instead of the freshly composed one.
 *
 * So the system message is kept as in-memory agent state and excluded from the
 * plugin's conversation transcript.
 */

/** Conversation messages, with pi's system message removed. */
export function conversationMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => message.role !== "system");
}

/** True when the message is the pi-owned system context rather than conversation. */
export function isSystemContextMessage(message: AgentMessage): boolean {
  return message.role === "system";
}

/**
 * Split the live agent transcript into its system context and conversation
 * halves. Returns the original array references so message identity (used for
 * de-dupe and session bookkeeping) is preserved.
 */
export function splitAgentMessages(messages: readonly AgentMessage[]): {
  system: AgentMessage[];
  conversation: AgentMessage[];
} {
  const system: AgentMessage[] = [];
  const conversation: AgentMessage[] = [];
  for (const message of messages) {
    if (isSystemContextMessage(message)) system.push(message);
    else conversation.push(message);
  }
  return { system, conversation };
}