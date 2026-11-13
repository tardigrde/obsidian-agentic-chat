import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { errorMessage } from "../utils/errors";
import type { AgentActionAuditRecorder } from "./action-audit-log";
import { estimateContextUsage } from "./compaction";
import type { AgentCompactionRuntime, AgentCompactionRunResult } from "./compaction-runtime";
import { conversationMessages } from "./conversation-messages";
import { CompactionNotLiveError, type AgentSessionActions } from "./session-actions";

export type ManualCompactionResult =
  | { compacted: true; beforeTokens: number; afterTokens: number; contextWindow: number }
  | { compacted: false; message: string };

const NOT_LIVE_HINT = "Reload the session to continue from the compacted transcript.";

export interface AgentConversationCompactionOptions {
  getAgent: () => Agent | null;
  session: Pick<AgentSessionActions, "getSessionToken" | "getBinding">;
  runtime: Pick<AgentCompactionRuntime, "compact" | "compactWithResult">;
  audit: Pick<AgentActionAuditRecorder, "record">;
  /** Non-transcript load (system prompt, tool schemas, reserve), as the context bar counts it. */
  getOverheadTokens: () => number;
  /** Surface a failure that leaves the conversation unusable until it is reloaded. */
  setError: (message: string) => void;
}

/**
 * The two ways a conversation is compacted: `/compact` and the automatic pass
 * before a turn. Both read the live transcript, run one pass of the compaction
 * runtime, and let the session queue land the result. This class owns what
 * differs: the audit pair and the result text of a manual pass, and the rule
 * that an automatic pass never fails the pending prompt.
 */
export class AgentConversationCompaction {
  constructor(private readonly options: AgentConversationCompactionOptions) {}

  /** User-triggered compaction of an idle conversation, optionally guided by instructions. */
  async runManual(customInstructions?: string): Promise<ManualCompactionResult> {
    const agent = this.options.getAgent();
    if (!agent) return { compacted: false, message: "Nothing compacted. No active conversation is loaded." };
    // Compact the conversation only. pi's system message stays as agent state,
    // and the replacement agent re-seeds it from the current system prompt.
    const messages = conversationMessages(agent.state.messages);
    const sessionToken = this.options.session.getSessionToken();
    const binding = this.options.session.getBinding();
    const contextWindow = agent.state.model?.contextWindow ?? 0;
    const overheadTokens = this.options.getOverheadTokens();
    const instructions = customInstructions?.trim() || undefined;
    const stats = {
      messageCount: messages.length,
      userTurns: messages.filter((message) => message.role === "user").length,
      estimatedTokens: estimateContextUsage(messages),
      contextWindow,
      hasInstructions: Boolean(instructions),
    };
    await this.options.audit.record({
      category: "compaction",
      action: "start",
      trigger: "manual",
      timestamp: new Date().toISOString(),
      ...stats,
    });
    if (this.options.session.getSessionToken() !== sessionToken) {
      return {
        compacted: false,
        message: "Nothing compacted. The active session changed before compaction started.",
      };
    }
    let result: AgentCompactionRunResult;
    try {
      result = await this.options.runtime.compactWithResult(messages, contextWindow, {
        force: true,
        overheadTokens,
        customInstructions: instructions,
        binding,
      });
    } catch (error) {
      if (error instanceof CompactionNotLiveError) {
        const message =
          "Compaction rewrote the saved session, but the live conversation could not be replaced: " +
          `${errorMessage(error.cause)}. ${NOT_LIVE_HINT}`;
        this.options.setError(message);
        return { compacted: false, message };
      }
      // A session change during summarization cancels the commit. Report it as
      // a normal manual-compaction result so `/compact` does not throw.
      return {
        compacted: false,
        message: `Nothing compacted. The active session changed while compacting: ${errorMessage(error)}`,
      };
    }
    if (result.status === "skipped") {
      await this.options.audit.record({
        category: "compaction",
        action: "end",
        trigger: "manual",
        timestamp: new Date().toISOString(),
        status: "skipped",
        reason: result.reason,
        message: result.message,
        ...stats,
      });
      return { compacted: false, message: result.message };
    }
    // The audit pair belongs to the session it started in. A swap that queued
    // behind the commit has already moved on; do not record the end there.
    if (this.options.session.getSessionToken() !== sessionToken) {
      return {
        compacted: false,
        message: "Nothing compacted. The active session changed while compacting.",
      };
    }
    // The rewrite carries existing audit entries over, so the start event
    // recorded above survives; record only the matching end event.
    await this.options.audit.record({
      category: "compaction",
      action: "end",
      trigger: "manual",
      timestamp: new Date().toISOString(),
      status: "compacted",
      replacementMessageCount: result.messages.length,
      ...stats,
    });
    return {
      compacted: true,
      // Report the same load the context bar shows: transcript plus overhead.
      beforeTokens: stats.estimatedTokens + overheadTokens,
      afterTokens: estimateContextUsage(result.messages) + overheadTokens,
      contextWindow,
    };
  }

  /**
   * Auto-compaction: when the transcript fills past the configured threshold,
   * summarize the older turns into a single message and keep the recent ones.
   * Best-effort: any failure before the rewrite (no key, summary error, write
   * error, session change) leaves the transcript untouched so a prompt is never
   * lost. Resolves with a message only when the rewrite landed but the live
   * transcript could not follow it; the pending turn must not run then.
   */
  async runAutomatic(): Promise<string | undefined> {
    const agent = this.options.getAgent();
    if (!agent) return undefined;
    const messages: AgentMessage[] = conversationMessages(agent.state.messages);
    try {
      await this.options.runtime.compact(messages, agent.state.model?.contextWindow ?? 0, {
        overheadTokens: this.options.getOverheadTokens(),
      });
    } catch (error) {
      if (error instanceof CompactionNotLiveError) {
        return (
          "Compaction rewrote the saved session, but the live conversation could not be replaced. " + NOT_LIVE_HINT
        );
      }
      // Compaction is an optimization; never let it break the pending prompt.
    }
    return undefined;
  }
}
