import type { Skill } from "@earendil-works/pi-agent-core";
import { formatSkillInvocation, parseCommandArgs, substituteArgs } from "@earendil-works/pi-agent-core";
import { parseYaml } from "obsidian";

// pi owns the spec-compatible formatting; we only handle loading from the vault.
export {
  formatSkillsForSystemPrompt,
  formatSkillInvocation,
  parseCommandArgs,
  substituteArgs,
} from "@earendil-works/pi-agent-core";

// $1–$9 / $@ / $ARGUMENTS / ${@:N} — the placeholders pi's substituteArgs understands.
// The positional case requires the digit not be followed by another digit, a period, or
// a comma, so currency in a skill body ($10, $1.50, $1,000, "costs $1.") isn't misread as
// a template. When detection is ambiguous we prefer NOT substituting: a literal `$1.` left
// in the output is obvious and fixable, whereas wrongly substituting silently corrupts text.
const ARG_PLACEHOLDER = /\$(?:ARGUMENTS|@|[1-9](?![\d.,])|\{@)/;

/**
 * Build the user-message prompt for invoking a skill, folding in any arguments.
 * If the body contains `$1`/`$ARGUMENTS`-style placeholders, the args are
 * substituted into it (templates are just skills with placeholders). Otherwise
 * the arg string is appended as freeform additional instructions.
 */
export function buildSkillInvocation(skill: Skill, argString?: string): string {
  const trimmed = argString?.trim() ?? "";
  if (!trimmed) return formatSkillInvocation(skill);
  if (ARG_PLACEHOLDER.test(skill.content)) {
    const substituted = substituteArgs(skill.content, parseCommandArgs(trimmed));
    return formatSkillInvocation({ ...skill, content: substituted });
  }
  return formatSkillInvocation(skill, trimmed);
}

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function splitFrontmatter(content: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { data: {}, body: content };
  let data: Record<string, unknown>;
  try {
    data = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
  } catch {
    data = {};
  }
  return { data, body: content.slice(match[0].length).trimStart() };
}

export function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
