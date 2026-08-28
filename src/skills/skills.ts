import type { Skill } from "@earendil-works/pi-agent-core";
import { formatSkillInvocation, parseCommandArgs, substituteArgs } from "@earendil-works/pi-agent-core";
import { parseYaml } from "obsidian";
import { normalizeVaultPath } from "../vault/path";

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
  /** Set when frontmatter exists but failed to parse as YAML. */
  parseProblem?: string;
}

export function splitFrontmatter(content: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { data: {}, body: content };
  let data: Record<string, unknown>;
  try {
    data = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
    return { data, body: content.slice(match[0].length).trimStart() };
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    return { data: {}, body: content.slice(match[0].length).trimStart(), parseProblem: `frontmatter is not valid YAML${detail}` };
  }
}

export function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Vault path of the skill's SKILL.md file; "(built-in)" for bundled skills. */
const BUILTIN_MARKER = "(built-in)";

/** Directory that contains the skill's SKILL.md, or null for built-ins. */
export function getSkillDir(skill: Skill): string | null {
  const filePath = skill.filePath;
  if (!filePath || filePath === BUILTIN_MARKER || filePath.startsWith("(")) return null;
  const slash = filePath.lastIndexOf("/");
  if (slash === -1) return null;
  return filePath.slice(0, slash);
}

/**
 * Resolve a relative path inside a skill's folder with strict confinement.
 * Joins `skillDir/relativePath`, normalizes, and ensures the result stays
 * inside the skill directory. Throws on absolute paths, `..` escapes, or
 * confinement violations.
 */
export function resolveSkillResourcePath(skill: Skill, relativePath: string): string {
  const dir = getSkillDir(skill);
  if (!dir) throw new Error(`Skill "${skill.name}" is built-in and has no additional files.`);
  const trimmed = relativePath.trim().replaceAll("\\", "/");
  if (!trimmed) throw new Error("path is required.");
  if (trimmed.startsWith("/")) throw new Error(`Path must be relative to skill folder, not absolute: "${relativePath}"`);
  const joined = `${dir}/${trimmed}`;
  let normalized: string;
  try {
    normalized = normalizeVaultPath(joined);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (normalized !== dir && !normalized.startsWith(`${dir}/`)) {
    throw new Error(`Path "${relativePath}" escapes skill folder "${skill.name}"; must stay inside ${dir}.`);
  }
  return normalized;
}
