export type HistoryDirection = -1 | 1;

export interface ComposerSelectionState {
  value: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
}

export interface HistoryRecallResult {
  handled: boolean;
  value?: string;
}

export const DEFAULT_MAX_COMPOSER_HISTORY = 200;

/** Shell-style composer history for Up/Down recall, independent from DOM state. */
export class ComposerHistory {
  private history: string[];
  private index: number | null = null;
  private draft: string | null = null;

  constructor(
    initialHistory: string[] = [],
    private readonly maxEntries = DEFAULT_MAX_COMPOSER_HISTORY,
  ) {
    this.history = trimHistory(initialHistory, maxEntries);
  }

  entries(): string[] {
    return [...this.history];
  }

  load(history: string[]): void {
    this.history = trimHistory(history, this.maxEntries);
    this.resetNavigation();
  }

  /** Record a submitted message, skipping consecutive duplicates. */
  record(text: string): void {
    if (this.history[this.history.length - 1] !== text) {
      this.history.push(text);
      if (this.history.length > this.maxEntries) this.history.shift();
    }
    this.resetNavigation();
  }

  resetNavigation(): void {
    this.index = null;
    this.draft = null;
  }

  /**
   * Recall older/newer history. Returns `handled: true` when the key should be
   * swallowed, even when the visible value does not change at the oldest entry.
   */
  recall(direction: HistoryDirection, state: ComposerSelectionState): HistoryRecallResult {
    if (this.history.length === 0) return { handled: false };
    if (!caretOnEdgeLine(state, direction)) return { handled: false };

    if (direction === -1) {
      if (this.index === null) {
        this.draft = state.value;
        this.index = this.history.length - 1;
      } else if (this.index > 0) {
        this.index -= 1;
      } else {
        return { handled: true };
      }
      return { handled: true, value: this.history[this.index] };
    }

    if (this.index === null) return { handled: false };
    if (this.index < this.history.length - 1) {
      this.index += 1;
      return { handled: true, value: this.history[this.index] };
    }

    const draft = this.draft ?? "";
    this.resetNavigation();
    return { handled: true, value: draft };
  }
}

/** True when the caret sits on the first line (up) or last line (down). */
export function caretOnEdgeLine(state: ComposerSelectionState, direction: HistoryDirection): boolean {
  const value = state.value;
  const start = state.selectionStart ?? 0;
  const end = state.selectionEnd ?? start;
  if (start !== end) return false;
  if (direction === -1) {
    const firstNewline = value.indexOf("\n");
    return start <= (firstNewline === -1 ? value.length : firstNewline);
  }
  return start > value.lastIndexOf("\n");
}

function trimHistory(history: string[], maxEntries: number): string[] {
  return history.slice(Math.max(0, history.length - maxEntries));
}
