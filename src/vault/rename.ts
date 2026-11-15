import type { App, TFile } from "obsidian";

/** Narrow view of the vault config store; `getConfig`/`setConfig` are not in the public typings. */
interface VaultConfigStore {
  getConfig(key: string): unknown;
  setConfig(key: string, value: unknown): void;
}

const ALWAYS_UPDATE_LINKS = "alwaysUpdateLinks";

/**
 * Serializes the config toggle below. Two renames that both need the toggle
 * must never interleave, or the second one would restore `false` while the
 * first one still needs `true`.
 */
let toggleQueue: Promise<unknown> = Promise.resolve();

/**
 * Rename a vault file without Obsidian's "Update links?" modal.
 *
 * With `alwaysUpdateLinks` off and backlinks present, `fileManager.renameFile`
 * opens a modal and never resolves until the user answers it. An agent turn
 * cannot answer it, so the turn hangs until the provider timeout. This helper
 * does what the modal's one-off choice does: turn the setting on, rename (links
 * update once), then restore the user's preference. The rename itself is the
 * only thing that runs while the flag is on.
 */
export async function renameVaultEntry(app: App, file: TFile, newPath: string): Promise<void> {
  const config = app.vault as unknown as VaultConfigStore;
  // The config read must happen inside the queue. A second rename that starts
  // while the first one has the flag on would otherwise see `true`, skip the
  // queue, and race the first one's restore back to `false`.
  const run = toggleQueue.then(async () => {
    const previous = config.getConfig(ALWAYS_UPDATE_LINKS);
    if (previous === true) {
      await app.fileManager.renameFile(file, newPath);
      return;
    }
    config.setConfig(ALWAYS_UPDATE_LINKS, true);
    try {
      await app.fileManager.renameFile(file, newPath);
    } finally {
      config.setConfig(ALWAYS_UPDATE_LINKS, previous);
    }
  });
  // Keep the queue usable after a failed rename; the caller still sees the error.
  toggleQueue = run.catch(() => undefined);
  await run;
}
