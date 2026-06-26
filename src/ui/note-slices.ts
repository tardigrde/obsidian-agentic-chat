import type { AttachmentFragment } from "./attachment-ref";

export interface NoteSlice {
  label: string;
  text: string;
}

export function extractNoteSlice(path: string, full: string, fragment: AttachmentFragment): NoteSlice | null {
  if (fragment.type === "heading") {
    return extractHeadingSlice(path, full, fragment.value);
  }
  return extractBlockSlice(path, full, fragment.value);
}

function extractHeadingSlice(path: string, full: string, heading: string): NoteSlice | null {
  const lines = splitLines(full);
  const target = normalizeHeading(heading);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseHeading(lines[index]);
    if (!parsed || normalizeHeading(parsed.text) !== target) continue;

    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = parseHeading(lines[next]);
      if (candidate && candidate.level <= parsed.level) {
        end = next;
        break;
      }
    }
    return {
      label: `${path}#${parsed.text}`,
      text: lines.slice(index, end).join("\n").trim(),
    };
  }
  return null;
}

function extractBlockSlice(path: string, full: string, blockId: string): NoteSlice | null {
  const lines = splitLines(full);
  const target = normalizeBlockId(blockId);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lineHasBlockId(lines[index], target)) continue;
    let start = index;
    while (start > 0 && lines[start - 1].trim()) start -= 1;
    let end = index + 1;
    while (end < lines.length && lines[end].trim()) end += 1;
    return {
      label: `${path}^${target}`,
      text: lines.slice(start, end).join("\n").trim(),
    };
  }
  return null;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function parseHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, text: match[2].replace(/\s+#+$/, "").trim() };
}

function normalizeHeading(value: string): string {
  return value
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeBlockId(value: string): string {
  return value.trim().replace(/^\^/, "");
}

function lineHasBlockId(line: string, blockId: string): boolean {
  const escaped = blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)\\^${escaped}(?:\\s*)$`).test(line.trim());
}
