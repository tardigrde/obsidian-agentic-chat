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

/**
 * Read the first existing instruction file from the vault root, or "" if none.
 * Uses the `DataAdapter` (raw-path, symlink-resolving, index-independent).
 */
export async function loadVaultInstructions(adapter: DataAdapter): Promise<string> {
  for (const name of INSTRUCTION_FILES) {
    if (await adapter.exists(name)) return await adapter.read(name);
  }
  return "";
}

/**
 * The system-prompt overlay for the standing instructions. Blank content yields no
 * overlay (so a vault with no instruction file costs nothing in the prompt).
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
      "overrides it.",
    "",
    trimmed,
  ].join("\n");
}
