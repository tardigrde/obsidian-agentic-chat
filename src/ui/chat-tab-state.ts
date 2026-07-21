import { ActiveNoteContextCache } from "./active-note";
import type { ContextAttachment } from "./context-attachments";

/**
 * Per-conversation working state. While a tab is active these values live on
 * ChatView fields; switching tabs saves the active values here and restores the
 * target tab's values.
 */
export interface ChatTabWorkingState {
  attachments: ContextAttachment[];
  activeNoteCache: ActiveNoteContextCache;
  activeNoteSuppressed: boolean;
  draft: string;
  queuedPromptArmed: boolean;
  sentHistory: string[];
  notifiedContext: Set<number>;
  notifiedCost: boolean;
  notifiedToolBudgetKey: string | null;
  lastCompactionCount: number;
  lastSentPrompt: string | null;
  lastSentDisplay: string | null;
}

/** A clean per-tab working state for a fresh conversation. */
export function freshChatTabState(): ChatTabWorkingState {
  return {
    attachments: [],
    activeNoteCache: new ActiveNoteContextCache(),
    activeNoteSuppressed: false,
    draft: "",
    queuedPromptArmed: false,
    sentHistory: [],
    notifiedContext: new Set<number>(),
    notifiedCost: false,
    notifiedToolBudgetKey: null,
    lastCompactionCount: 0,
    lastSentPrompt: null,
    lastSentDisplay: null,
  };
}
