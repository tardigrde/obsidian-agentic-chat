import type { DataAdapter } from "obsidian";

/**
 * Standing instructions: a single root-level file the agent loads as system-prompt
 * context every turn — the standard AGENTS.md / CLAUDE.md convention. The user (or
 * the agent, via the normal edit/write tools) maintains it; `/init` curates it.
 *
 * Precedence is AGENTS.md → CLAUDE.md → GEMINI.md (first found). Reads go through
 * the vault `DataAdapter` so a symlinked file resolves and an unindexed file still
 * loads. The overlay formatter is pure so it stays unit-testable without an app.
 */

/**
 * Filename precedence for the standing-instructions file. First existing file wins;
 * the others are typically symlinks to it so other agents (Claude Code, Gemini CLI)
 * in the same vault share one source of truth.
 */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;

/** True for the root-level standing-instructions file names that are injected implicitly. */
export function isInstructionFilePath(path: string): boolean {
  const normalized = path.trim().replace(/^\/+/, "");
  if (normalized.includes("/")) return false;
  return INSTRUCTION_FILES.some((name) => name.toLowerCase() === normalized.toLowerCase());
}

/**
 * Cap on how much of the instruction file is injected into the system prompt. A
 * runaway `/init` or a pasted file can grow large; loading tens of KB into every
 * turn silently inflates cost and can exhaust the context window before the
 * transcript ever compacts. The cap bounds the injected text, not the file.
 */
export const MAX_INSTRUCTIONS_CHARS = 16_000;

/**
 * Read the first existing instruction file from the vault root, or "" if none.
 * Uses the `DataAdapter` (raw-path, symlink-resolving, index-independent).
 *
 * Reads are guarded per file: a transient vault error (broken symlink, a
 * directory sitting at the name, or a race between `exists` and `read`) skips
 * that file and tries the next rather than aborting the whole turn. Content
 * beyond {@link MAX_INSTRUCTIONS_CHARS} is truncated with a visible notice.
 */
export async function loadVaultInstructions(adapter: DataAdapter): Promise<string> {
  for (const name of INSTRUCTION_FILES) {
    try {
      if (!(await adapter.exists(name))) continue;
      const content = await adapter.read(name);
      if (content.length <= MAX_INSTRUCTIONS_CHARS) return content;
      return (
        content.slice(0, MAX_INSTRUCTIONS_CHARS) +
        `\n\n[truncated: ${name} is ${content.length.toLocaleString()} chars; only the first ` +
        `${MAX_INSTRUCTIONS_CHARS.toLocaleString()} are loaded — shorten ${name} to load it fully.]`
      );
    } catch {
      continue;
    }
  }
  return "";
}

/**
 * The system-prompt overlay for the standing instructions. Blank content yields no
 * overlay (so a vault with no instruction file costs nothing in the prompt).
 *
 * The file's contents are bounded by an explicit start cue and an end marker so
 * vault-controlled text can't run on and impersonate the plugin's own overlay
 * scaffolding (e.g. a `## ` heading that reads as authoritative framing).
 */
export function formatInstructionsOverlay(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return [
    "## Project instructions",
    "",
    "The vault's standing-instructions file (AGENTS.md / CLAUDE.md / GEMINI.md) — durable guidance " +
      "for working in this vault, maintained by the user and editable by you through the normal " +
      "edit/write tools. Treat it as standing context: honor it unless the current task clearly " +
      "overrides it. The file's verbatim contents follow, through the end marker.",
    "",
    trimmed,
    "",
    "<!-- end of standing-instructions file -->",
  ].join("\n");
}
