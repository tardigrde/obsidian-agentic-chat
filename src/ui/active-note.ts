/**
 * Pure helpers for the "active note pointer". The model is told where the user is
 * (the active note and the other open notes), never given the text: it reads what
 * it needs with `read` (line ranges) or `vault_inspect` (search). A pointer is a few
 * dozen tokens and, sent only when it changes, never touches the prompt cache.
 * All Obsidian I/O lives in `context-builder.ts`; this module stays pure.
 */

export interface ActiveNoteState {
  /** Path of the current active note, or null when there is none. */
  activePath: string | null;
  /** Explicitly attached entries; an explicit attachment wins (don't double-attach). */
  explicit: string[];
  /** Notes whose selected text is already attached; don't also point at the whole note. */
  selectedTextSources?: string[];
}

/**
 * The active note to point at this turn, or null when it should be skipped: no
 * active note, or already an explicit attachment.
 */
export function effectiveActiveNote(state: ActiveNoteState): string | null {
  if (!state.activePath) return null;
  if (state.explicit.includes(state.activePath)) return null;
  if (state.selectedTextSources?.includes(state.activePath)) return null;
  return state.activePath;
}

export interface ActiveNoteCandidate {
  path: string;
  extension: string;
}

/**
 * Current editor file to point at. Only Markdown files are useful, and ignored
 * files never leak, not even as a path.
 */
export function autoActiveNotePath(
  file: ActiveNoteCandidate | null | undefined,
  options: { isIgnored: (path: string) => boolean },
): string | null {
  if (!file) return null;
  if (file.extension.toLowerCase() !== "md") return null;
  if (options.isIgnored(file.path)) return null;
  return file.path;
}

/**
 * The focused note when it is private (U4 #11): it is never named to the model,
 * and the composer shows a "private, not sent" chip so the user knows why.
 */
export function privateActiveNotePath(
  file: ActiveNoteCandidate | null | undefined,
  options: { isIgnored: (path: string) => boolean },
): string | null {
  if (!file) return null;
  if (file.extension.toLowerCase() !== "md") return null;
  return options.isIgnored(file.path) ? file.path : null;
}

/** Most open notes named in the pointer; a long tab list is noise. */
export const MAX_OPEN_NOTES = 10;
/** A selection longer than this is named by size, not quoted. */
export const MAX_POINTER_SELECTION_CHARS = 2_000;

export interface ActiveNotePointer {
  path: string;
  /** Other open note paths (no ignored paths, no duplicates, not the active note). */
  openPaths: readonly string[];
  /** The editor selection inside the active note, or empty. */
  selection?: string;
}

/**
 * The pointer section. It starts with `Active note "<path>"` so the context
 * escaping and dedupe keep treating it like any other section. It carries no
 * line counts or properties: those change on every edit and the model gets them
 * on demand from `vault_inspect`. A short selection adds its text, so the pointer
 * is a few dozen tokens, plus at most 2,000 characters when text is selected.
 */
export function buildActiveNotePointer(pointer: ActiveNotePointer): string {
  const lines = [
    `Active note "${pointer.path}" (a pointer as of this message; its text is not attached. Use read with startLine/endLine or vault_inspect to open what you need).`,
  ];
  // A blank-line rule in the selection would look like the section separator and
  // cut the held pointer short when the dedupe reads it back.
  const selection = (pointer.selection?.trim() ?? "").replaceAll("\n\n---\n\n", "\n\n\\---\n\n");
  if (selection) {
    lines.push(
      selection.length <= MAX_POINTER_SELECTION_CHARS
        ? `Selected text in it:\n${selection}`
        : `${selection.length.toLocaleString("en-US")} characters are selected in it; use vault_inspect with active_note and includeSelection to read them.`,
    );
  }
  const open = pointer.openPaths.slice(0, MAX_OPEN_NOTES);
  if (open.length > 0) lines.push(`Other open notes: ${open.map((path) => `"${path}"`).join(", ")}`);
  return lines.join("\n");
}
