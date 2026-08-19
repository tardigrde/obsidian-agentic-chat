import type { Skill } from "@earendil-works/pi-agent-core";
import { splitFrontmatter, stringField } from "./skills";

/**
 * The single parser for Agent Skills documents (`SKILL.md`): frontmatter
 * `name`/`description` + body. Every skill in the plugin — built-ins and
 * plugin packages — is produced through this primitive so all of them conform
 * to the Agent Skills specification (https://agentskills.io/specification).
 * A document is invalid (and skipped) when `name` or `description` are
 * missing or malformed; the body is unrestricted, matching the spec's
 * minimal frontmatter-only example.
 */
export interface ParsedSkill {
  /** Parsed skill when the document is usable; null when it must be skipped. */
  skill: Skill | null;
  /** Problems that make the document invalid, or empty. */
  problems: string[];
}

/**
 * Agent Skills `name` constraints per the spec + reference validator:
 * 1-64 code points, NFKC-normalized Unicode lowercase letters/numbers and
 * hyphens, no edge or consecutive hyphens.
 */
export function skillNameProblem(name: string): string | null {
  const length = [...name].length;
  if (length < 1 || length > 64) {
    return "Skill name must be 1-64 characters.";
  }
  if (name !== name.toLowerCase()) {
    return "Skill name must be lowercase.";
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    return "Skill name cannot start or end with a hyphen.";
  }
  if (name.includes("--")) {
    return "Skill name cannot contain consecutive hyphens.";
  }
  if (!/^[\p{L}\p{N}-]+$/u.test(name)) {
    return "Skill name may contain only Unicode letters, numbers, and hyphens.";
  }
  return null;
}

export function parseSkillMarkdown(raw: string, filePath: string): ParsedSkill {
  const { data, body, parseProblem } = splitFrontmatter(raw);
  if (parseProblem) {
    return { skill: null, problems: [parseProblem] };
  }
  const name = stringField(data, "name");
  if (!name) {
    return { skill: null, problems: ['SKILL.md is missing a "name" frontmatter field.'] };
  }
  // NFKC per the spec's reference validator; the directory comparison in the
  // loader uses the same normalization.
  const normalizedName = name.normalize("NFKC");
  const nameProblem = skillNameProblem(normalizedName);
  if (nameProblem) {
    return { skill: null, problems: [nameProblem] };
  }
  const description = stringField(data, "description");
  if (!description) {
    return { skill: null, problems: ['SKILL.md is missing a "description" frontmatter field.'] };
  }
  if ([...description].length > 1024) {
    return { skill: null, problems: ['SKILL.md "description" must be at most 1024 characters.'] };
  }
  return {
    skill: { name: normalizedName, description, content: body, filePath },
    problems: [],
  };
}
