/**
 * Pure helpers for serializing explicit `@`-mention attachments into the prompt
 * context. Kept separate from `chat-view` so the budget + restricted-path rules
 * are testable without the Obsidian UI.
 *
 * Two guardrails live here:
 *  - **Budget (token blowup):** an attachment is inlined in full only up to a
 *    char budget; larger notes become a path-only reference the model opens with
 *    `read`. This keeps a stack of attachments from dumping hundreds of
 *    thousands of tokens into the context.
 *  - **Restricted (ignore-listed):** a path the user has ignore-listed is never
 *    inlined — not even read. The model gets at most a "noted, contents
 *    withheld" reference, so an active note in a private folder can't leak.
 */

/** Char budget for inlining an explicit attachment's full content. */
export const MAX_ATTACHMENT_CHARS = 8_000;

export interface AttachmentContent {
  path: string;
  /** Full note text, or null when it can't be read. */
  full: string | null;
  /** Char budget for inlining the full note. */
  limit?: number;
  /** True when the path is ignore-listed: never inline content, path-only reference. */
  restricted?: boolean;
}

/**
 * Serialize an explicit attachment:
 *  - restricted → contents withheld (the path is noted but never readable),
 *  - fits the budget → full inline,
 *  - over budget → path-only reference (the model opens it with `read` if needed),
 *  - unreadable → path-only reference.
 */
export function buildAttachmentSection(content: AttachmentContent): string {
  const { path, full, restricted } = content;
  const limit = content.limit ?? MAX_ATTACHMENT_CHARS;
  if (restricted) {
    return `Note "${path}" is in a restricted (ignore-listed) location; its contents are withheld. It is noted here only because you referenced it — use a different note.`;
  }
  if (full !== null && full.length <= limit) {
    return `Contents of note "${path}":\n\n${full}`;
  }
  if (full !== null && full.length > limit) {
    return `Note "${path}" is attached by reference (~${full.length.toLocaleString()} chars — too large to inline). Use the read tool to open it.`;
  }
  return `Note "${path}" is attached by reference (could not be read). Use the read tool to open it.`;
}
