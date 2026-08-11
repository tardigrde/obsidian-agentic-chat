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

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Agent Skills `name` constraints: 1-64 chars of lowercase a-z/0-9/hyphens, no edge or double hyphens. */
export function skillNameProblem(name: string): string | null {
  if (name.length < 1 || name.length > 64) {
    return "Skill name must be 1-64 characters.";
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return "Skill name may contain only lowercase a-z, 0-9, and hyphens, without leading, trailing, or consecutive hyphens.";
  }
  return null;
}

export function parseSkillMarkdown(raw: string, filePath: string): ParsedSkill {
  const { data, body } = splitFrontmatter(raw);
  const name = stringField(data, "name");
  if (!name) {
    return { skill: null, problems: ['SKILL.md is missing a "name" frontmatter field.'] };
  }
  const nameProblem = skillNameProblem(name);
  if (nameProblem) {
    return { skill: null, problems: [nameProblem] };
  }
  const description = stringField(data, "description");
  if (!description) {
    return { skill: null, problems: ['SKILL.md is missing a "description" frontmatter field.'] };
  }
  if (description.length > 1024) {
    return { skill: null, problems: ['SKILL.md "description" must be at most 1024 characters.'] };
  }
  return {
    skill: { name, description, content: body, filePath },
    problems: [],
  };
}
