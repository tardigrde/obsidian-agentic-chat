import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { getCompactedUsage } from "./compaction";
import { addUsage, emptyUsage, sumAssistantUsage } from "./usage";
import { messageText, parseSubagentReport } from "./subagent-reports";

/** Child usage as the subagent tool persists it on each child (`details.children[].usage`). */
interface PersistedChildUsage {
  input?: number;
  output?: number;
  totalTokens?: number;
  costUsd?: number;
}

/**
 * Usage of the subagent dispatches recorded in the transcript: each dispatch's
 * tool result keeps its children's usage, so the cost survives a reload
 * (U4 #8). Returns the ids of the dispatches it counted.
 */
export function sumSubagentResultUsage(messages: readonly AgentMessage[]): { usage: Usage; dispatchIds: Set<string> } {
  const usage = emptyUsage();
  const dispatchIds = new Set<string>();
  for (const message of messages) {
    // U5 #1: a background child's usage lands with its report, after the dispatch result.
    if (message.role === "user") {
      const report = parseSubagentReport(messageText(message));
      if (report?.usage) addUsage(usage, subagentDetailsUsage({ kind: "subagent", children: [{ usage: report.usage }] }) ?? emptyUsage());
      continue;
    }
    if (message.role !== "toolResult") continue;
    const result = message as { toolCallId?: string; details?: unknown };
    const dispatch = subagentDetailsUsage(result.details);
    if (!dispatch) continue;
    if (result.toolCallId) dispatchIds.add(result.toolCallId);
    addUsage(usage, dispatch);
  }
  return { usage, dispatchIds };
}

/** The children's usage of one subagent dispatch's `details`, or undefined for any other tool. */
export function subagentDetailsUsage(details: unknown): Usage | undefined {
  const shaped = details as { kind?: string; children?: unknown } | undefined;
  if (shaped?.kind !== "subagent" || !Array.isArray(shaped.children)) return undefined;
  const usage = emptyUsage();
  for (const child of shaped.children as Array<{ usage?: PersistedChildUsage } | null>) {
    const childUsage = child?.usage;
    if (!childUsage) continue;
    const cost = Number.isFinite(childUsage.costUsd) ? (childUsage.costUsd as number) : 0;
    addUsage(usage, {
      input: childUsage.input ?? 0,
      output: childUsage.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: childUsage.totalTokens ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    });
  }
  return usage;
}

/**
 * Sum all token/cost usage that belongs to a visible session transcript: the
 * parent's model calls, the subagent dispatches saved in it, usage carried by
 * compaction summaries, and `childUsage` of dispatches still running (not yet
 * in the transcript).
 */
export function sumSessionUsage(messages: AgentMessage[], childUsage: Usage = emptyUsage()): Usage {
  const total = emptyUsage();
  const assistant = sumAssistantUsage(messages);
  if (assistant) addUsage(total, assistant);
  addUsage(total, sumSubagentResultUsage(messages).usage);
  addUsage(total, childUsage);
  for (const message of messages) {
    const compacted = getCompactedUsage(message);
    if (compacted) addUsage(total, compacted);
  }
  return total;
}
