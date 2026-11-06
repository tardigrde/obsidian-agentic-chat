import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface CompactionTranscript {
  messages: AgentMessage[];
  contextWindow: number;
}

export interface AgentCompactionOrchestratorOptions {
  getTranscript: () => CompactionTranscript | null;
  compact: (messages: AgentMessage[], contextWindow: number) => Promise<AgentMessage[] | null>;
  markPersistedMessages: (messages: AgentMessage[]) => void;
  replaceAgent: (messages: AgentMessage[]) => void;
  refreshActiveSessionInfo: () => void;
  notifyChange: () => void;
  /**
   * Called when the JSONL rewrite succeeded but the in-memory replacement
   * failed. Return true when the caller reloaded the persisted transcript and
   * the runtime is usable again.
   */
  recoverAfterReplaceFailure?: (error: unknown) => Promise<boolean> | boolean;
  /** Observability hook; `persisted` is true once the rewrite landed on disk. */
  onCompactionFailure?: (error: unknown, persisted: boolean) => void;
}

export async function maybeCompactAgentTranscript(options: AgentCompactionOrchestratorOptions): Promise<boolean> {
  let persisted = false;
  try {
    const transcript = options.getTranscript();
    if (!transcript) return false;
    const newMessages = await options.compact(transcript.messages, transcript.contextWindow);
    if (!newMessages) return false;
    // From here on the session file holds the compacted transcript. A failed
    // in-memory replace must not leave the agent on the stale transcript.
    persisted = true;
    options.markPersistedMessages(newMessages);
    try {
      options.replaceAgent(newMessages);
    } catch (error) {
      if (!(await options.recoverAfterReplaceFailure?.(error))) throw error;
      options.refreshActiveSessionInfo();
      options.notifyChange();
      return true;
    }
    options.refreshActiveSessionInfo();
    options.notifyChange();
    return true;
  } catch (error) {
    options.onCompactionFailure?.(error, persisted);
    // Compaction is an optimization; never let it break the pending prompt.
    return false;
  }
}
