import type { AgenticChatSettings } from "./settings-schema";

export type SettingsChangeListener = (settings: AgenticChatSettings) => void;

/**
 * One owner for plugin settings: the live object, the only save path, and the
 * change listeners. Callers mutate through {@link update} (mutate + save once)
 * or call {@link save} after an existing mutation. A listener runs only after a
 * save succeeds, so it never observes settings that data.json does not hold.
 */
export class SettingsStore {
  private current: AgenticChatSettings;
  private writes: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<SettingsChangeListener>();

  constructor(
    initial: AgenticChatSettings,
    private readonly persist: (settings: AgenticChatSettings) => Promise<void>,
  ) {
    this.current = initial;
  }

  get settings(): AgenticChatSettings {
    return this.current;
  }

  /** Swap the live object after a load or heal. Does not save or notify. */
  replace(settings: AgenticChatSettings): void {
    this.current = settings;
  }

  /** Subscribe to successful saves. Returns an unsubscribe function. */
  onChange(listener: SettingsChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Mutate the live settings, then save once. A mutator that returns `false`
   * made no change, so the save is skipped. Returns true when settings were
   * saved.
   */
  async update(mutator: (settings: AgenticChatSettings) => boolean | void): Promise<boolean> {
    if (mutator(this.current) === false) return false;
    await this.save();
    return true;
  }

  /** Persist the current settings and notify listeners after a successful save. */
  save(): Promise<void> {
    const run = this.writes.then(() => this.persist(this.current));
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => this.notify());
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.current);
      } catch (error: unknown) {
        console.warn("Agentic chat: settings change listener failed", error);
      }
    }
  }
}
