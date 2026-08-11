import type { Skill } from "@earendil-works/pi-agent-core";
import { splitFrontmatter, stringField } from "./skills";

/**
 * The single parser for Agent Skills documents (`SKILL.md`): frontmatter
 * `name`/`description` + body. Every skill in the plugin — built-ins, plugin
 * packages, and any future source — is produced through this primitive so all
 * of them conform to the same schema.
 */
export interface ParsedSkill {
  /** Parsed skill when the document is usable; null when it must be skipped. */
  skill: Skill | null;
  /** Problems that make the document invalid, or empty. */
  problems: string[];
}

export function parseSkillMarkdown(raw: string, filePath: string, fallbackName?: string): ParsedSkill {
  const { data, body } = splitFrontmatter(raw);
  if (!body.trim()) {
    return { skill: null, problems: ["SKILL.md has an empty body."] };
  }
  const name = stringField(data, "name") ?? (fallbackName?.trim() || null);
  if (!name) {
    return { skill: null, problems: ['SKILL.md is missing a "name" frontmatter field.'] };
  }
  const description = stringField(data, "description") ?? name;
  return {
    skill: { name, description, content: body, filePath },
    problems: [],
  };
}
