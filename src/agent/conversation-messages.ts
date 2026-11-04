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
 * system message. A persisted leading system message would therefore pin a
 * stale prompt on reload; persisted tool-change messages would also bloat the
 * JSONL and replay stale declarations.
 *
 * So the system message is kept as in-memory agent state and excluded from the
 * plugin's conversation transcript.
 *
 * This filter is load-bearing on more than persistence: pi-ai's
 * `estimateMessageTokens` prices a `system` message (the 0.85.1 harness priced
 * it at zero), and on a first turn `estimateNextRequestCost` adds the system
 * prompt separately, so a system-bearing transcript would double-count it.
 * Every caller that estimates or persists must go through here.
 *
 * Uses `filter` so message object identity survives; the session recorder's
 * `WeakSet` de-dupe keys on it.
 */
export function conversationMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => message.role !== "system");
}
