import type { ContextAttachment } from "./context-attachments";

/**
 * Per-conversation working state. While a tab is active these values live on
 * ChatView fields; switching tabs saves the active values here and restores the
 * target tab's values.
 */
export interface ChatTabWorkingState {
  attachments: ContextAttachment[];
  activeNoteSuppressed: boolean;
  draft: string;
  sentHistory: string[];
  notifiedContext: Set<number>;
  notifiedCost: boolean;
  lastCompactionCount: number;
  lastSentPrompt: string | null;
  lastSentDisplay: string | null;
}

/** A clean per-tab working state for a fresh conversation. */
export function freshChatTabState(): ChatTabWorkingState {
  return {
    attachments: [],
    activeNoteSuppressed: false,
    draft: "",
    sentHistory: [],
    notifiedContext: new Set<number>(),
    notifiedCost: false,
    lastCompactionCount: 0,
    lastSentPrompt: null,
    lastSentDisplay: null,
  };
}
