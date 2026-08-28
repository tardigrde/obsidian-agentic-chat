/**
 * In-memory loaded-skill registry for H8 progressive disclosure.
 * Tracks which skills have been explicitly loaded via `load_skill` so their
 * full bodies can be injected into the system prompt on subsequent turns.
 * Unload frees context. State is per-app-process (cleared on reload), not
 * persisted to disk — F10's `read_skill` stays one-off, `load_skill` is
 * persistent for the session.
 */

const loaded = new Set<string>();

export function isSkillLoaded(name: string): boolean {
  return loaded.has(name);
}

export function loadSkill(name: string): void {
  loaded.add(name);
}

export function unloadSkill(name: string): boolean {
  return loaded.delete(name);
}

export function clearLoadedSkills(): void {
  loaded.clear();
}

export function getLoadedSkillNames(): string[] {
  return [...loaded];
}
