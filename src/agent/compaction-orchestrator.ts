import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface CompactionTranscript {
  messages: AgentMessage[];
  contextWindow: number;
  /** Non-transcript load (system prompt, tool schemas, reserve), as the context bar counts it. */
  overheadTokens?: number;
}

export interface AgentCompactionOrchestratorOptions {
  getTranscript: () => CompactionTranscript | null;
  compact: (messages: AgentMessage[], contextWindow: number, overheadTokens?: number) => Promise<AgentMessage[] | null>;
  /** Install the compacted transcript on the live agent and publish the change. */
  install: (messages: AgentMessage[]) => void;
  /**
   * Called when the JSONL rewrite succeeded but the in-memory install failed.
   * Return true when the caller reloaded and published the persisted
   * transcript and the runtime is usable again.
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
    const newMessages = await options.compact(transcript.messages, transcript.contextWindow, transcript.overheadTokens);
    if (!newMessages) return false;
    // From here on the session file holds the compacted transcript. A failed
    // in-memory replace must not leave the agent on the stale transcript.
    persisted = true;
    try {
      options.install(newMessages);
    } catch (error) {
      // Recovery reloads the persisted transcript and publishes it itself.
      if (!(await options.recoverAfterReplaceFailure?.(error))) throw error;
    }
    return true;
  } catch (error) {
    options.onCompactionFailure?.(error, persisted);
    // Compaction is an optimization; never let it break the pending prompt.
    return false;
  }
}
