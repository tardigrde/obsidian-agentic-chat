import { estimateContextTokens, estimateTokens, type AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Auto-compaction configuration. Fractions are of the model's context window.
 * Kept separate from the persisted settings shape (which stores percents) so this
 * module stays pure and testable without depending on `AgenticChatSettings`.
 */
export interface CompactionConfig {
  /** Enable automatic summarization of old turns as context fills. */
  enabled: boolean;
  /** Fill fraction (0–1) at which compaction triggers. */
  thresholdFraction: number;
  /** Fraction (0–1) of recent context to retain verbatim after compaction. */
  keepFraction: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  thresholdFraction: 0.8,
  keepFraction: 0.3,
};

/** A decision to fold `summarize` into a summary and keep `keep` verbatim. */
export interface CompactionPlan {
  /** Older messages to fold into a single summary message. */
  summarize: AgentMessage[];
  /** Recent messages retained verbatim, beginning at a user-turn boundary. */
  keep: AgentMessage[];
  /** Estimated context tokens before compaction (for logging/notices). */
  tokensBefore: number;
}

/** Estimated context tokens the transcript currently occupies. */
export function estimateContextUsage(messages: AgentMessage[]): number {
  return estimateContextTokens(messages).tokens;
}

/**
 * Decide whether and how to compact. Returns `null` when compaction is disabled,
 * the window is unknown, the transcript is still under threshold, or there aren't
 * at least two user turns to split (one to summarize, one to keep).
 *
 * The cut point is always a user-message boundary, so assistant/tool-result pairs
 * are never orphaned and the retained messages remain a valid model context.
 */
export function planCompaction(
  messages: AgentMessage[],
  contextWindow: number,
  config: CompactionConfig,
): CompactionPlan | null {
  if (!config.enabled || contextWindow <= 0) return null;
  const tokensBefore = estimateContextUsage(messages);
  if (tokensBefore <= contextWindow * config.thresholdFraction) return null;

  const userIndices = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  // Need a turn to summarize (index 0) and at least one later turn to keep.
  if (userIndices.length < 2) return null;

  const keepBudget = Math.max(0, contextWindow * config.keepFraction);
  // Candidate cut points are user boundaries after the first turn. Pick the
  // earliest cut whose retained tokens fit the keep budget (i.e. retain as much
  // recent history as fits); fall back to keeping only the final turn.
  const candidates = userIndices.slice(1);
  let cut = candidates[candidates.length - 1];
  for (const candidate of candidates) {
    if (tokensFrom(messages, candidate) <= keepBudget) {
      cut = candidate;
      break;
    }
  }

  const summarize = messages.slice(0, cut);
  const keep = messages.slice(cut);
  if (summarize.length === 0 || keep.length === 0) return null;
  return { summarize, keep, tokensBefore };
}

/** Estimated tokens for the messages from `index` to the end. */
function tokensFrom(messages: AgentMessage[], index: number): number {
  let total = 0;
  for (let i = index; i < messages.length; i++) total += estimateTokens(messages[i]);
  return total;
}

/**
 * Wrap a summary string as a user message that replaces compacted history. A user
 * message converts cleanly for every provider and reads to the model as prior
 * context; the marker makes it identifiable in the transcript and on reload.
 */
export function buildSummaryMessage(summary: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `Earlier conversation was automatically summarized to save context:\n\n<conversation-summary>\n${summary.trim()}\n</conversation-summary>`,
      },
    ],
    timestamp,
  };
}

/** True when a message is a compaction summary produced by {@link buildSummaryMessage}. */
export function isSummaryMessage(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.includes("<conversation-summary>"),
  );
}
