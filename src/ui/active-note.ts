/**
 * Pure helpers for the "active note attached by default" composer behavior. The
 * active leaf is auto-attached as a removable context chip; this module decides
 * *whether* it should be attached and *how* its content is rendered into the
 * prompt context (the truncation ladder). All Obsidian I/O lives in `ChatView`;
 * keeping this logic pure makes the default/suppress/truncation rules testable
 * without the app.
 */

/** Char budget above which the full active note is too large to inline verbatim. */
export const MAX_ACTIVE_NOTE_CHARS = 16_000;

export interface ActiveNoteState {
  /** Path of the current active note, or null when there is none. */
  activePath: string | null;
  /** The user dismissed the auto chip — stay suppressed for the rest of the session. */
  suppressed: boolean;
  /** Explicitly attached entries; an explicit attachment wins (don't double-attach). */
  explicit: string[];
}

/**
 * The active note to auto-attach this turn, or null when it should be skipped:
 * suppressed by the user, no active note, or already an explicit attachment.
 */
export function effectiveActiveNote(state: ActiveNoteState): string | null {
  if (state.suppressed) return null;
  if (!state.activePath) return null;
  if (state.explicit.includes(state.activePath)) return null;
  return state.activePath;
}

export interface ActiveNoteCandidate {
  path: string;
  extension: string;
}

/**
 * Current editor file to offer as the auto-active note chip. Only Markdown files
 * are useful as inline prompt context, and ignored files should not leak even as
 * an automatic path chip. Manual attachments still handle ignored paths as
 * path-only references.
 */
export function autoActiveNotePath(
  file: ActiveNoteCandidate | null | undefined,
  options: { suppressed: boolean; isIgnored: (path: string) => boolean },
): string | null {
  if (options.suppressed) return null;
  if (!file) return null;
  if (file.extension.toLowerCase() !== "md") return null;
  if (options.isIgnored(file.path)) return null;
  return file.path;
}

export interface ActiveNoteContent {
  path: string;
  /** Full note text, or null when it can't be read. */
  full: string | null;
  /** Best-effort slice of the editor's visible range, used when the full note is too long. */
  visibleRange?: string | null;
  /** Char budget for inlining the full note. */
  limit: number;
}

/**
 * Truncation ladder for the auto-attached active note:
 *  1. the full note when it fits the budget,
 *  2. otherwise the visible editor range (best-effort) when available,
 *  3. otherwise a labeled path-only reference (the model can open it with `read`).
 */
export function buildActiveNoteSection(content: ActiveNoteContent): string {
  const { path, full, visibleRange, limit } = content;
  if (full !== null && full.length <= limit) {
    return `Active note "${path}":\n\n${full}`;
  }
  if (visibleRange && visibleRange.trim()) {
    return (
      `Active note "${path}" (too long to include in full — showing the portion visible in the editor):\n\n` +
      visibleRange
    );
  }
  return `Active note "${path}" (attached by reference — too long to inline; use the read tool to open it).`;
}
