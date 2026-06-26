import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { getCompactedUsage } from "./compaction";
import { addUsage, emptyUsage, sumAssistantUsage } from "./usage";

/** Sum all token/cost usage that belongs to a visible session transcript. */
export function sumSessionUsage(messages: AgentMessage[], childUsage: Usage = emptyUsage()): Usage {
  const total = emptyUsage();
  const assistant = sumAssistantUsage(messages);
  if (assistant) addUsage(total, assistant);
  addUsage(total, childUsage);
  for (const message of messages) {
    const compacted = getCompactedUsage(message);
    if (compacted) addUsage(total, compacted);
  }
  return total;
}
