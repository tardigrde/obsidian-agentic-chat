/**
 * In-memory loaded-skill registry for H8 progressive disclosure.
 * Tracks which skills have been explicitly loaded via `load_skill` so their
 * full bodies can be injected into the system prompt on subsequent turns.
 * Unload frees context. Each chat service owns one registry, so state is not
 * shared across vaults or plugin instances. It is not persisted to disk —
 * F10's `read_skill` stays one-off, `load_skill` is persistent for the session.
 */

export class SkillLoadRegistry {
  private readonly loaded = new Set<string>();

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  load(name: string): void {
    this.loaded.add(name);
  }

  unload(name: string): boolean {
    return this.loaded.delete(name);
  }

  clear(): void {
    this.loaded.clear();
  }

  names(): string[] {
    return [...this.loaded];
  }

  /** Remove any loaded names that no longer correspond to an available skill. */
  prune(availableNames: Set<string>): void {
    for (const name of [...this.loaded]) {
      if (!availableNames.has(name)) this.loaded.delete(name);
    }
  }
}
