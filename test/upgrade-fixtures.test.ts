import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeSettings, retiredSettingsNotices } from "../src/settings-schema";
import { migrateLegacyPlaintextSecrets } from "../src/secrets/legacy-plaintext";
import { hydrateSettingsSecrets, MemorySecretStore, settingsForStorage } from "../src/secrets/secret-store";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { parseSessionEntries } from "../src/session/jsonl";
import { MemoryAdapter } from "./helpers/memory-adapter";

/**
 * Upgrade lane (#290): load the data.json and session JSONL that each released
 * version wrote (captured with `npm run capture:release-fixtures -- <tag>`)
 * through HEAD's load path. Catches silent behavior changes (#284) and lost
 * secrets (#285) on upgrade.
 */

const RELEASES_DIR = path.join("test", "fixtures", "releases");
const releases = existsSync(RELEASES_DIR) ? readdirSync(RELEASES_DIR).sort() : [];

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** Replays HEAD's `loadSettings` order: migrate secrets, notices, merge, hydrate. */
function loadLikeHead(stored: Record<string, unknown>, store: MemorySecretStore) {
  const failures = migrateLegacyPlaintextSecrets(stored, store);
  const notices = retiredSettingsNotices(stored);
  const settings = mergeSettings(stored);
  hydrateSettingsSecrets(settings, store);
  return { failures, notices, settings };
}

describe("upgrade fixtures", () => {
  it("has at least one captured release", () => {
    expect(releases.length).toBeGreaterThan(0);
  });

  describe.each(releases)("from %s", (release) => {
    const dir = path.join(RELEASES_DIR, release);

    function freshStore(): MemorySecretStore {
      const store = new MemorySecretStore();
      for (const [id, value] of Object.entries(readJson(path.join(dir, "secrets.json")))) {
        if (typeof value === "string" && value) store.setSecret(id, value);
      }
      return store;
    }

    it("loads data.json without losing a secret or a retired-setting notice", () => {
      const stored = readJson(path.join(dir, "data.json"));
      const approval = (stored.approval ?? {}) as Record<string, unknown>;
      const { failures, notices, settings } = loadLikeHead(structuredClone(stored), freshStore());

      expect(failures).toEqual([]);
      // Every secret the release stored still reaches runtime settings.
      expect(settings.openrouterApiKey).toBe("fixture-not-a-real-key");
      // Retired settings the release persisted are reported, never dropped silently.
      if ("workingDirs" in approval) {
        expect(notices.some((n) => n.startsWith("Working directories were removed"))).toBe(true);
      }
      if (["plan", "ask", "agent"].includes(String(stored.mode))) {
        expect(notices.some((n) => n.includes("mode was removed"))).toBe(true);
        expect(settings.mode).toBe("safe");
      }
    });

    it("is stable after the first save: a second load has no notices and the same settings", () => {
      const store = freshStore();
      const first = loadLikeHead(readJson(path.join(dir, "data.json")), store);
      const saved = JSON.parse(JSON.stringify(settingsForStorage(first.settings, store))) as Record<string, unknown>;
      const second = loadLikeHead(saved, store);

      expect(second.notices).toEqual([]);
      expect(second.failures).toEqual([]);
      expect(second.settings).toEqual(first.settings);
    });

    it("replays every saved session through HEAD's session manager", async () => {
      const sessionsDir = path.join(dir, "sessions");
      const files = readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = readFileSync(path.join(sessionsDir, file), "utf8");
        const savedMessages = parseSessionEntries(content).filter((entry) => entry.type === "message").length;
        const adapter = new MemoryAdapter();
        await adapter.mkdir("sessions");
        await adapter.write(`sessions/${file}`, content);
        const manager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:fixture");

        const listed = await manager.listSessions();
        expect(listed.map((info) => info.path)).toEqual([`sessions/${file}`]);
        await manager.loadSession(`sessions/${file}`);
        const context = manager.buildSessionContext();
        expect(context.messages).toHaveLength(savedMessages);
        expect(context.model).not.toBeNull();
      }
    });
  });
});
