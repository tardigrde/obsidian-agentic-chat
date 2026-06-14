import type { SlashCommand } from "./commands";

/** Attachment entries for folders carry this prefix; bare paths are files. */
export const FOLDER_PREFIX = "folder:";

/** Cap suggestions so the menu (and large vaults) stay manageable. */
const MAX_ITEMS = 50;

export type AcKind = "command" | "skill" | "mention";

export interface AcItem {
  kind: AcKind;
  /** Display label, e.g. "/new", a skill name, or a note basename. */
  label: string;
  /** Secondary text: a description or a path. */
  detail: string;
  /** Lucide icon name for `setIcon`. */
  icon: string;
  /** Opaque value consumed by `resolve` (command name, skill name, attach entry). */
  value: string;
}

export interface AcQuery {
  kind: AcKind;
  /** [start, end] character range in the input occupied by the trigger token. */
  range: [number, number];
  /** Partial text after the trigger character (matched case-insensitively). */
  query: string;
}

export interface MentionCandidate {
  path: string;
  type: "file" | "folder";
  /** Display name; defaults to the last path segment. */
  name?: string;
}

export interface AcContext {
  commands: SlashCommand[];
  skills: Array<{ name: string; description: string }>;
  files: MentionCandidate[];
}

export interface AcResolution {
  text: string;
  caret: number;
  /** When set, the chosen item is an attachment to add (mention completion). */
  attach?: string;
}

/**
 * Decide whether the caret sits inside an autocompletable token.
 *
 * - `^/word` (no space yet) → command menu.
 * - `/skill <partial>` or `/template <partial>` (first arg) → skill menu.
 * - `@partial` preceded by start-of-line or whitespace → mention menu.
 *
 * Returns null when nothing should open. Only text *before* the caret matters;
 * the range it reports is what `resolve` replaces.
 */
export function detectQuery(text: string, caret: number): AcQuery | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const end = before.length;

  const command = /^\/(\S*)$/.exec(before);
  if (command) return { kind: "command", range: [0, end], query: command[1] };

  const skill = /^\/(?:skill|template)\s+(\S*)$/.exec(before);
  if (skill) return { kind: "skill", range: [end - skill[1].length, end], query: skill[1] };

  const at = before.lastIndexOf("@");
  if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]))) {
    const token = before.slice(at + 1);
    if (!/\s/.test(token)) return { kind: "mention", range: [at, end], query: token };
  }
  return null;
}

/** Position of `query` in `text` (case-insensitive); -1 when absent. Lower = earlier = better. */
function matchScore(query: string, text: string): number {
  if (!query) return 0;
  return text.toLowerCase().indexOf(query.toLowerCase());
}

interface Scored<T> {
  item: T;
  score: number;
}

function rank<T>(items: Scored<T>[]): T[] {
  return items
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_ITEMS)
    .map((entry) => entry.item);
}

/** Produce ranked suggestions for a detected query. */
export function suggest(query: AcQuery, context: AcContext): AcItem[] {
  if (query.kind === "command") return suggestCommands(query.query, context.commands);
  if (query.kind === "skill") return suggestSkills(query.query, context.skills);
  return suggestMentions(query.query, context.files);
}

/** Best (lowest, earliest) match score across several candidate strings; -1 if none match. */
function bestMatchScore(query: string, candidates: string[]): number {
  const scores = candidates.map((text) => matchScore(query, text)).filter((n) => n >= 0);
  return scores.length > 0 ? Math.min(...scores) : -1;
}

function suggestCommands(query: string, commands: SlashCommand[]): AcItem[] {
  const scored = commands.map((command): Scored<AcItem> => {
    const names = [command.name, ...(command.aliases ?? [])];
    return {
      score: bestMatchScore(query, names),
      item: {
        kind: "command",
        label: `/${command.name}${command.args ? ` ${command.args}` : ""}`,
        detail: command.description,
        icon: "terminal",
        value: command.name,
      },
    };
  });
  return rank(scored);
}

function suggestSkills(query: string, skills: Array<{ name: string; description: string }>): AcItem[] {
  const scored = skills.map((skill): Scored<AcItem> => ({
    score: matchScore(query, skill.name),
    item: { kind: "skill", label: skill.name, detail: skill.description, icon: "sparkles", value: skill.name },
  }));
  return rank(scored);
}

function suggestMentions(query: string, files: MentionCandidate[]): AcItem[] {
  const scored = files.map((file): Scored<AcItem> => {
    const name = file.name ?? file.path.split("/").pop() ?? file.path;
    // Match on the basename first; fall back to the full path so "folder/note" works.
    const score = bestMatchScore(query, [name, file.path]);
    return {
      score,
      item: {
        kind: "mention",
        label: name,
        detail: file.path,
        icon: file.type === "folder" ? "folder" : "file-text",
        value: file.type === "folder" ? `${FOLDER_PREFIX}${file.path}` : file.path,
      },
    };
  });
  return rank(scored);
}

/**
 * Apply a chosen item to the input, returning the new text + caret position. For
 * mentions the token is stripped and `attach` carries the entry to add as context;
 * for commands/skills the token is filled in with a trailing space.
 */
export function resolve(text: string, query: AcQuery, item: AcItem): AcResolution {
  const before = text.slice(0, query.range[0]);
  const after = text.slice(query.range[1]);

  if (item.kind === "mention") {
    return { text: before + after, caret: before.length, attach: item.value };
  }
  const insert = item.kind === "command" ? `/${item.value} ` : `${item.value} `;
  return { text: before + insert + after, caret: before.length + insert.length };
}
