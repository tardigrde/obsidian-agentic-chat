export interface QuickAskPosition {
  line: number;
  ch: number;
}

export interface QuickAskEditorLike {
  getSelection(): string;
  getCursor(which?: "from" | "to"): QuickAskPosition;
  getLine(line: number): string;
}

export interface QuickAskTarget {
  kind: "selection" | "line";
  text: string;
  from: QuickAskPosition;
  to: QuickAskPosition;
  path?: string;
}

export interface QuickAskProposal {
  target: QuickAskTarget;
  instruction: string;
  replacement: string;
  summary: string;
}

export function buildQuickAskTarget(editor: QuickAskEditorLike, path?: string): QuickAskTarget {
  const selection = editor.getSelection();
  if (selection.length > 0) {
    return {
      kind: "selection",
      text: selection,
      from: editor.getCursor("from"),
      to: editor.getCursor("to"),
      path,
    };
  }

  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);
  return {
    kind: "line",
    text: line,
    from: { line: cursor.line, ch: 0 },
    to: { line: cursor.line, ch: line.length },
    path,
  };
}

export function buildQuickAskProposal(target: QuickAskTarget, instruction: string): QuickAskProposal | null {
  const trimmed = instruction.trim();
  if (!trimmed) return null;
  const replacement = applyQuickAskInstruction(target.text, trimmed);
  if (replacement === null || replacement === target.text) return null;
  return {
    target,
    instruction: trimmed,
    replacement,
    summary: `${target.kind === "selection" ? "Selection" : "Line"} edit`,
  };
}

export function applyQuickAskInstruction(text: string, instruction: string): string | null {
  const normalized = instruction.trim().toLowerCase();
  const replacement = explicitReplacement(instruction);
  if (replacement !== null) return replacement;
  const appended = explicitAppend(text, instruction);
  if (appended !== null) return appended;
  const prefixed = explicitPrefix(text, instruction);
  if (prefixed !== null) return prefixed;

  if (/\bupper(?:case)?\b/.test(normalized)) return text.toUpperCase();
  if (/\blower(?:case)?\b/.test(normalized)) return text.toLowerCase();
  if (/\bsentence case\b/.test(normalized)) return sentenceCase(text);
  if (/\btitle case\b/.test(normalized)) return titleCase(text);
  if (/\btrim\b|\btrim whitespace\b/.test(normalized)) return trimLines(text);
  if (/\bquote\b|\bblockquote\b/.test(normalized)) return prefixLines(text, "> ");
  if (/\bnumber(?:ed)?\b/.test(normalized)) return numberLines(text);
  if (/\bbullet(?:s|ed)?\b|\blist\b/.test(normalized)) return bulletLines(text);
  return null;
}

function explicitReplacement(instruction: string): string | null {
  const match = /^(?:replace|rewrite)(?:\s+with)?\s*:\s*([\s\S]+)$/i.exec(instruction.trim());
  return match ? match[1] : null;
}

function explicitAppend(text: string, instruction: string): string | null {
  const match = /^append\s*:\s*([\s\S]+)$/i.exec(instruction.trim());
  if (!match) return null;
  const separator = text.endsWith("\n") || text.length === 0 ? "" : "\n";
  return `${text}${separator}${match[1]}`;
}

function explicitPrefix(text: string, instruction: string): string | null {
  const match = /^prefix\s*:\s*([\s\S]+)$/i.exec(instruction.trim());
  return match ? `${match[1]}${text}` : null;
}

function sentenceCase(text: string): string {
  return text.toLowerCase().replace(/(^\s*[\p{L}\p{N}]|[.!?]\s+[\p{L}\p{N}])/gu, (match) => match.toUpperCase());
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*/gu, (word) => {
    const first = word[0] ?? "";
    return `${first.toUpperCase()}${word.slice(1)}`;
  });
}

function trimLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

function bulletLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `- ${line.replace(/^[-*]\s+/, "").trim()}` : line))
    .join("\n");
}

function numberLines(text: string): string {
  let number = 1;
  return text
    .split("\n")
    .map((line) => (line.trim() ? `${number++}. ${line.replace(/^\d+[.)]\s+/, "").trim()}` : line))
    .join("\n");
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `${prefix}${line}` : line))
    .join("\n");
}
