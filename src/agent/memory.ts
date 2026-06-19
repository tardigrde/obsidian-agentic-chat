/**
 * Durable memory store (M1). A persisted, user-authored set of facts +
 * instructions the agent carries across turns and sessions.
 *
 * Per-vault scope, stored in the plugin `data.json` (via settings) so it works
 * on desktop and mobile without Node fs. Surfaced to the model as a
 * system-prompt overlay (same path output styles use), and readable/writable
 * through the `remember`/`recall` tools (see `src/tools/memory-tools.ts`).
 *
 * The helpers here are pure so the store and its overlay stay unit-testable
 * without an Obsidian app or a running agent.
 */

/**
 * Soft cap on persisted memory text. It ships in the system prompt every turn,
 * so bound it to protect the context window and per-turn cost. Generous for
 * personal facts/instructions; `remember` refuses once exceeded (rather than
 * silently dropping) so the model knows to consolidate.
 */
export const MEMORY_MAX_CHARS = 8_000;

/**
 * Append one durable fact/instruction to the memory text. A blank `fact` is a
 * no-op; a fact already starting with a list marker is kept verbatim, otherwise
 * it is formatted as a bullet so the overlay reads as a clean checklist.
 */
export function appendMemory(memory: string, fact: string): string {
  const trimmed = fact.trim();
  if (!trimmed) return memory;
  const line = trimmed.startsWith("-") || /^\d+\./.test(trimmed) ? trimmed : `- ${trimmed}`;
  const base = memory.replace(/\s+$/g, "");
  return base ? `${base}\n${line}` : line;
}

/**
 * The system-prompt overlay carrying the durable memory. Blank memory yields no
 * overlay (so the default store costs nothing in the prompt until used).
 */
export function formatMemoryOverlay(memory: string): string {
  const trimmed = memory.trim();
  if (!trimmed) return "";
  return [
    "## Memory",
    "",
    "These are durable facts and instructions saved across conversations — by the user " +
      "directly in settings, or by you via the `remember` tool. Treat them as standing context: " +
      "honor them unless the current task clearly overrides them.",
    "",
    trimmed,
  ].join("\n");
}
