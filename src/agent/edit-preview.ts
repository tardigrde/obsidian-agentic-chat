import { applyExactEdits, type ExactEdit } from "../vault/edit";

/** What a pending mutating tool call would do, ready for the approval modal to render. */
export type EditPreview =
  | { kind: "diff"; path: string; before: string; after: string; isNew: boolean }
  | { kind: "delete"; path: string; content: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "none" };

interface RawArgs {
  path?: unknown;
  content?: unknown;
  newPath?: unknown;
  edits?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Narrow unknown tool args to well-formed edits. The model controls these, so a
 * malformed shape (null, a string, missing fields) is filtered out rather than
 * cast through — leaving applyExactEdits to throw on the empty result, which the
 * caller turns into `kind: "none"`.
 */
function asExactEdits(value: unknown): ExactEdit[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (edit): edit is ExactEdit =>
      typeof edit === "object" &&
      edit !== null &&
      typeof (edit as ExactEdit).oldText === "string" &&
      typeof (edit as ExactEdit).newText === "string",
  );
}

/**
 * Describe a mutating tool call as a reviewable change, given the file's current
 * content (`null` when it doesn't exist yet). Pure: the modal supplies the
 * content it read from the vault. Returns `kind: "none"` for non-previewable
 * calls (unknown tool, or an `edit` whose `oldText` no longer matches).
 */
export function buildEditPreview(toolName: string, args: unknown, currentContent: string | null): EditPreview {
  const raw = (args ?? {}) as RawArgs;
  const path = asString(raw.path);
  switch (toolName) {
    case "write":
      return {
        kind: "diff",
        path,
        before: currentContent ?? "",
        after: asString(raw.content),
        isNew: currentContent === null,
      };
    case "edit": {
      const before = currentContent ?? "";
      try {
        const after = applyExactEdits(before, asExactEdits(raw.edits));
        return { kind: "diff", path, before, after, isNew: false };
      } catch {
        return { kind: "none" };
      }
    }
    case "delete":
      return { kind: "delete", path, content: currentContent ?? "" };
    case "rename":
      return { kind: "rename", from: path, to: asString(raw.newPath) };
    default:
      return { kind: "none" };
  }
}
