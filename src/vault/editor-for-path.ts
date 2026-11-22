import type { App } from "obsidian";

/** The part of a Markdown view the plugin reads: its file and its editor selection. */
export interface EditorViewLike {
  file?: { path?: string } | null;
  editor?: { getSelection?: () => string };
}

/**
 * The Markdown editor showing `path`, found among every open leaf. The chat view
 * has focus while a prompt is sent, so `workspace.getActiveViewOfType(MarkdownView)`
 * is null then; the note the user is working in is still open in its own leaf.
 */
export function editorViewForPath(app: App, path: string): EditorViewLike | null {
  const matches = (view: unknown): view is EditorViewLike => {
    const candidate = view as EditorViewLike | null | undefined;
    return !!candidate && candidate.file?.path === path && typeof candidate.editor?.getSelection === "function";
  };
  const workspace = app.workspace as {
    getActiveViewOfType?: (type: never) => unknown;
    iterateAllLeaves?: (callback: (leaf: { view: unknown }) => void) => void;
  };
  let found: EditorViewLike | null = null;
  workspace.iterateAllLeaves?.((leaf) => {
    if (!found && matches(leaf.view)) found = leaf.view;
  });
  return found;
}

/** The text selected in the editor that shows `path`, or "". */
export function selectionForPath(app: App, path: string): string {
  return editorViewForPath(app, path)?.editor?.getSelection?.() ?? "";
}
