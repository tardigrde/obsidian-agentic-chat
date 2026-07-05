import type { Skill } from "@earendil-works/pi-agent-core";
import { formatSkillsForSystemPrompt } from "../skills/skills";
import { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt";

export { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt";

/**
 * Compose the system prompt: the base prompt, then any mode/output-style overlays
 * (blank overlays are dropped), then the model-visible block listing skills.
 */
export function buildSystemPrompt(basePrompt: string, skills: Skill[], overlays: string[] = []): string {
  const parts = [basePrompt.trim() || DEFAULT_SYSTEM_PROMPT];
  for (const overlay of overlays) {
    const trimmed = overlay.trim();
    if (trimmed) parts.push(trimmed);
  }
  if (skills.length > 0) parts.push(formatSkillsForSystemPrompt(skills));
  return parts.join("\n\n");
}
