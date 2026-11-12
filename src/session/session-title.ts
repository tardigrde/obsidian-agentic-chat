/** The prompt-assembly focus hint (`FOCUS_HINT` in ui/context-builder) that follows a context block. */
const FOCUS_HINT_LINE = /^Focus: The user's request after this line is the primary task\.[^\r\n]*(?:\r?\n)*/;

/**
 * The user's own text of a sent prompt: drops a leading `<context…</context>`
 * block and the focus hint right after it. A prompt with no context block is
 * returned as is, so a user prompt that starts with "Focus:" stays.
 */
export function stripPromptPreamble(prompt: string): string {
  // Eat only the line breaks after the block, so the user's first-line
  // indentation stays. CRLF and LF both work.
  const contextMatch = /^<context\b[\s\S]*?<\/context>[ \t]*(?:\r?\n)*/.exec(prompt);
  return contextMatch ? prompt.slice(contextMatch[0].length).replace(FOCUS_HINT_LINE, "") : prompt;
}

/**
 * Derive a short session title from the first user prompt. Strips any attachment
 * preamble (`<context>…</context>` or the `<context unchanged …</context>` marker)
 * and the focus hint after it, collapses whitespace, and trims to a handful of
 * words. Deterministic (no model call) — see ROADMAP for the model-based upgrade.
 */
export function deriveAutoName(firstMessage: string): string | undefined {
  const withoutContext = stripPromptPreamble(firstMessage);
  const slashStripped = withoutContext.replace(/^\/(?:skill|template)\s+/, "");
  const condensed = slashStripped.replace(/\s+/g, " ").trim();
  if (!condensed) return undefined;
  const words = condensed.split(" ").slice(0, 8).join(" ");
  let capped = words;
  if (capped.length > 60) {
    capped = capped.slice(0, 60);
    const lastSpace = capped.lastIndexOf(" ");
    capped = `${(lastSpace > 0 ? capped.slice(0, lastSpace) : capped).trimEnd()}…`;
  }
  const cleaned = capped.replace(/[.,;:!?]+$/, "");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
