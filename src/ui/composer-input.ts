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
 *   text after the current model turn; undelivered text returns to the composer.
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

/** Status shown when steered text comes back to the composer undelivered. */
export const UNDELIVERED_STEER_STATUS =
  "Your message was not delivered before the turn ended. Press Enter to send it.";

/**
 * Put steered text that never reached the model back into the composer. Keeps
 * only the user's words (no attachment preamble) and appends to any draft with
 * a blank line between, so a draft is never overwritten. Null when nothing is left.
 */
export function restoreUndeliveredText(draft: string, texts: readonly string[]): string | null {
  const restored = texts.map((text) => stripContextPreamble(text).trim()).filter((text) => text.length > 0);
  if (restored.length === 0) return null;
  return [draft.trimEnd(), ...restored].filter((part) => part.length > 0).join("\n\n");
}
