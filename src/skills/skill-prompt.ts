/**
 * Agent Skills prompt rendering.
 *
 * These helpers used to live in `pi-agent-core`'s experimental harness. Pi
 * 1.0.0 removed the harness from that package (durable sessions moved to
 * `@earendil-works/pi-durable`), and no other pi package exposes a skill
 * type or a spec-compatible renderer. The plugin owns them here so the
 * Agent Skills surface (https://agentskills.io/specification) stays stable
 * across pi upgrades.
 */

/**
 * A skill the plugin can invoke: a named instruction document loaded from a
 * vault `SKILL.md` or bundled as a built-in. Defined here because pi 1.0.0
 * dropped the harness that used to export it, and no replacement package
 * exposes a skill type.
 *
 * `name`, `description`, and `filePath` are rendered into the system prompt
 * as an XML block by {@link formatSkillsForSystemPrompt}.
 */
export interface Skill {
  /** Stable skill name used for lookup and model-visible listings. */
  name: string;
  /** Short model-visible description of when to use the skill. */
  description: string;
  /** Full skill instructions. */
  content: string;
  /**
   * Path of the skill file, used for model-visible location and for resolving
   * relative references. Built-ins use `"(built-in)"`.
   */
  filePath: string;
  /** Hide from model-visible skill lists while keeping explicit invocation working. */
  disableModelInvocation?: boolean;
}

/**
 * Directory containing a skill's file, used to resolve relative references
 * inside a skill body. Vault paths are POSIX, but a plugin package can carry a
 * Windows-style path, so both separators and trailing slashes are handled.
 */
function skillDirName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  // Keep the `C:` drive root intact instead of returning `C`.
  if (separatorIndex === 2 && normalized[1] === ":") return normalized.slice(0, 3);
  return separatorIndex <= 0 ? "/" : normalized.slice(0, separatorIndex);
}

/** Escape text for safe interpolation into the skill XML blocks. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render the `<available_skills>` catalog block for the system prompt.
 *
 * Skills marked `disableModelInvocation` are omitted: they stay invocable by
 * name but must not steer the model toward themselves. Returns `""` when
 * nothing is model-visible, so callers can skip the section entirely.
 */
export function formatSkillsForSystemPrompt(skills: readonly Skill[]): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the full skill file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

/**
 * Wrap a skill body in the invocation block sent as a user message, optionally
 * appending extra user instructions after it.
 */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
  // Skill names are validated to letters/digits/hyphens and the body is the
  // model's own instruction text, so name/location are interpolated verbatim
  // to keep the rendered block byte-identical to what pi's harness emitted.
  const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skillDirName(skill.filePath)}.\n\n${skill.content}\n</skill>`;
  return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}