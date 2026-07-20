/** A literal text slice the user attached from the editor context menu. */
export interface TextContextAttachment {
  type: "text";
  id: string;
  label: string;
  text: string;
  sourcePath?: string;
}

/** Composer context attachment: either a vault path/folder token or inline text. */
export type ContextAttachment = string | TextContextAttachment;

export interface TextContextAttachmentInput {
  text: string;
  sourcePath?: string;
}

/** Keep selected text context bounded; larger selections are truncated visibly. */
export const MAX_TEXT_CONTEXT_CHARS = 12_000;

export function isTextContextAttachment(entry: ContextAttachment): entry is TextContextAttachment {
  return typeof entry !== "string" && entry.type === "text";
}

export function createTextContextAttachment(input: TextContextAttachmentInput): TextContextAttachment {
  const text = input.text.trim();
  const source = input.sourcePath?.trim() || undefined;
  return {
    type: "text",
    id: `selection:${source ?? "editor"}:${hashText(text)}`,
    label: source ? `${source} selection` : "Selection",
    text,
    sourcePath: source,
  };
}

/** Stable key for deduping attachment chips. */
export function contextAttachmentKey(entry: ContextAttachment): string {
  return isTextContextAttachment(entry) ? entry.id : entry;
}

/** Human label for chips and sent-message attachment summaries. */
export function contextAttachmentLabel(entry: ContextAttachment): string {
  return isTextContextAttachment(entry) ? entry.label : entry;
}

export function textContextSection(entry: TextContextAttachment, restricted: boolean): string {
  const source = entry.sourcePath ? ` from "${entry.sourcePath}"` : "";
  if (restricted) {
    return `Selected text${source} is in a restricted (ignore-listed) location; its contents are withheld.`;
  }
  const clipped = entry.text.length > MAX_TEXT_CONTEXT_CHARS;
  const body = clipped ? entry.text.slice(0, MAX_TEXT_CONTEXT_CHARS) : entry.text;
  const note = clipped ? `\n\n[Selected text truncated at ${MAX_TEXT_CONTEXT_CHARS} characters.]` : "";
  return `Selected text${source}:\n\n${body}${note}`;
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
