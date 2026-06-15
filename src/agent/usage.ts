import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

/** A zeroed usage accumulator, including a zeroed cost breakdown. */
export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Add `from` into `into` field-by-field. Local providers may omit cost entirely. */
export function addUsage(into: Usage, from: Usage): void {
  into.input += from.input ?? 0;
  into.output += from.output ?? 0;
  into.cacheRead += from.cacheRead ?? 0;
  into.cacheWrite += from.cacheWrite ?? 0;
  into.totalTokens += from.totalTokens ?? 0;
  if (from.cost) {
    into.cost.input += from.cost.input ?? 0;
    into.cost.output += from.cost.output ?? 0;
    into.cost.cacheRead += from.cost.cacheRead ?? 0;
    into.cost.cacheWrite += from.cost.cacheWrite ?? 0;
    into.cost.total += from.cost.total ?? 0;
  }
}

/**
 * Sum token usage across every assistant message in a transcript. Returns
 * undefined when no assistant message carries usage (e.g. a child that errored
 * before its first turn), so callers can skip accounting noise.
 */
export function sumAssistantUsage(messages: AgentMessage[]): Usage | undefined {
  let found = false;
  const total = emptyUsage();
  for (const message of messages) {
    if (message.role === "assistant" && message.usage) {
      addUsage(total, message.usage);
      found = true;
    }
  }
  return found ? total : undefined;
}
