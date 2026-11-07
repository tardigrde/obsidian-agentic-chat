import { stripContextPreamble as stripFromBuilder } from "./context-builder";

/** Strip an attachment `<context>...</context>` preamble for display/retry fallback. */
export function stripContextPreamble(text: string): string {
  return stripFromBuilder(text);
}

/** Who asked the composer to submit: the Enter key or the toolbar button. */
export type ComposerSubmitSource = "enter" | "button";

/** What a composer submission should do with the current text. */
export type ComposerAction = "send" | "steer" | "queue";

/**
 * One decision for the composer send path.
 *
 * - An idle submission sends the text as a new turn.
 * - Enter while the agent runs steers the active turn. The runtime delivers the
 *   text after the next completed tool batch.
 * - The toolbar button while the agent runs holds the draft until the turn ends.
 */
export function resolveComposerAction(source: ComposerSubmitSource, isStreaming: boolean): ComposerAction {
  if (!isStreaming) return "send";
  return source === "button" ? "queue" : "steer";
}

export function parseInlineInstruction(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("#")) return null;
  return trimmed.slice(1).trim() || null;
}
