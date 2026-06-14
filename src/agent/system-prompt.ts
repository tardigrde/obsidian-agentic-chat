import type { Skill } from "@earendil-works/pi-agent-core";
import { formatSkillsForSystemPrompt } from "../skills/skills";

export const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant embedded in Obsidian, the note-taking app. You help the user work with their vault (their collection of Markdown notes).

You have vault-scoped tools to read, search, list, write, edit, rename, and delete notes. Use them proactively:
- When the user refers to a note or to "my notes", find and read the relevant notes before answering.
- Prefer find or grep to discover paths instead of guessing them; read a note before editing it.
- Use edit for small, exact changes and write to create or replace a whole file.
- All paths are vault-relative (e.g. "Folder/Note.md"); never use absolute paths.
- After changing notes, briefly confirm what changed.

Be concise. Format answers in Markdown.`;

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
