import { ActiveNoteContextCache } from "./active-note";
import { ComposerHistory } from "./composer-history";
import type { ContextAttachment } from "./context-attachments";
import { PromptContextCache } from "./context-builder";

/**
 * Per-conversation working state, owned by one chat tab. ChatView reads and
 * writes the active tab's object directly; there is no live copy to save or
 * restore on a tab switch. Only `draft` is parked here while the tab is in the
 * background, because the textarea holds it while the tab is active.
 */
export interface ChatTabWorkingState {
  attachments: ContextAttachment[];
  activeNoteCache: ActiveNoteContextCache;
  contextCache: PromptContextCache;
  activeNoteSuppressed: boolean;
  /** Composer text while the tab is in the background. */
  draft: string;
  queuedPromptArmed: boolean;
  /** Shell-style Up/Down recall of this tab's sent messages. */
  history: ComposerHistory;
  notifiedContext: Set<number>;
  notifiedCost: boolean;
  notifiedToolBudgetKey: string | null;
  /** Compaction count last surfaced to the user, so each compaction toasts once. */
  lastCompactionCount: number;
  /** Last prompt sent (with its context preamble), so Retry re-runs it exactly. */
  lastSentPrompt: string | null;
  /** What the user typed for that prompt, shown in the retried bubble. */
  lastSentDisplay: string | null;
}

/** A clean per-tab working state for a fresh conversation. */
export function freshChatTabState(): ChatTabWorkingState {
  return {
    attachments: [],
    activeNoteCache: new ActiveNoteContextCache(),
    contextCache: new PromptContextCache(),
    activeNoteSuppressed: false,
    draft: "",
    queuedPromptArmed: false,
    history: new ComposerHistory(),
    notifiedContext: new Set<number>(),
    notifiedCost: false,
    notifiedToolBudgetKey: null,
    lastCompactionCount: 0,
    lastSentPrompt: null,
    lastSentDisplay: null,
  };
}

/** Which parts of a tab's conversation state a session change discards. */
export interface ChatTabStateReset {
  attachments?: boolean;
  activeNoteSuppression?: boolean;
  activeNoteCache?: boolean;
  contextCache?: boolean;
  lastSent?: boolean;
  history?: boolean;
}

/** Reset the selected parts of a tab's state in place. */
export function resetChatTabState(state: ChatTabWorkingState, reset: ChatTabStateReset): void {
  if (reset.attachments) state.attachments = [];
  if (reset.activeNoteCache) state.activeNoteCache = new ActiveNoteContextCache();
  if (reset.contextCache) state.contextCache = new PromptContextCache();
  if (reset.activeNoteSuppression) state.activeNoteSuppressed = false;
  if (reset.lastSent) {
    state.lastSentPrompt = null;
    state.lastSentDisplay = null;
  }
  if (reset.history) state.history.resetNavigation();
}

/**
 * The context one send reads from its tab, captured when the send starts. The
 * caches are captured by reference: a session reset during the send replaces
 * the tab's caches, and this send must settle the ones it staged into, not the
 * fresh ones.
 */
export interface StagedPromptContext {
  attachments: ContextAttachment[];
  autoPath: string | null;
  activeNoteCache: ActiveNoteContextCache;
  contextCache: PromptContextCache;
  /** Drop what this send staged without changing the transcript. */
  discard(): void;
  /** Commit the staged context when the turn reached the transcript, else discard it. */
  settle(delivered: boolean): void;
}

export function stagePromptContext(state: ChatTabWorkingState, autoPath: string | null): StagedPromptContext {
  const { activeNoteCache, contextCache } = state;
  const discard = (): void => {
    activeNoteCache.discardPending();
    contextCache.discard();
  };
  return {
    attachments: [...state.attachments],
    autoPath,
    activeNoteCache,
    contextCache,
    discard,
    settle: (delivered) => {
      if (!delivered) {
        discard();
        return;
      }
      activeNoteCache.commitPending();
      contextCache.commit();
    },
  };
}
