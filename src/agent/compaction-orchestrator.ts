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
}

export async function maybeCompactAgentTranscript(options: AgentCompactionOrchestratorOptions): Promise<boolean> {
  try {
    const transcript = options.getTranscript();
    if (!transcript) return false;
    const newMessages = await options.compact(transcript.messages, transcript.contextWindow);
    if (!newMessages) return false;
    options.markPersistedMessages(newMessages);
    options.replaceAgent(newMessages);
    options.refreshActiveSessionInfo();
    options.notifyChange();
    return true;
  } catch {
    // Compaction is an optimization; never let it break the pending prompt.
    return false;
  }
}
