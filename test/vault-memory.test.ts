import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  appendDailyEntry,
  deleteMemoryFiles,
  formatDailyEntry,
  formatMemoryFile,
  isMemoryPath,
  loadMemoryOverlay,
  mergeAutoBullets,
  migrateLegacyRecords,
  parseMemoryFile,
  resolveMemoryPaths,
  shouldDistillNow,
  MEMORY_AUTO_MARKER,
  type VaultMemorySettings,
} from "../src/memory/vault-memory";
import { distillDailyToMemory } from "../src/memory/distill-runtime";
import { meetsDistillThreshold } from "../src/memory/session-feedstock";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import { MemoryAdapter } from "./helpers/memory-adapter";

const SETTINGS = {
  ...DEFAULT_SETTINGS,
  memory: { enabled: true, store: "plugin", vaultFolder: "memory", modelOverride: "" } as VaultMemorySettings,
};
const PATHS = resolveMemoryPaths(".obsidian", SETTINGS.memory);

function userMessage(content: string): AgentMessage {
  return { role: "user", content } as AgentMessage;
}

function assistantMessage(content: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text: content }] } as AgentMessage;
}

function session(n: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < n; i++) {
    messages.push(userMessage(`User question number ${i} about the vault structure, notes organization, and how the weekly review process should handle the growing backlog of meeting notes`));
    messages.push(assistantMessage(`Assistant answer number ${i} with some detail about notes, folders, tags, and the proposed dataview queries for the review dashboard`));
  }
  return messages;
}

describe("distill delta threshold", () => {
  it("skips tiny deltas without spending tokens", () => {
    expect(meetsDistillThreshold([]).eligible).toBe(false);
    expect(meetsDistillThreshold([userMessage("hi"), assistantMessage("hello there")]).eligible).toBe(false);
    expect(meetsDistillThreshold(session(3)).eligible).toBe(true);
  });
});

describe("vault memory Tier-2", () => {
  it("merges without clobbering the human section", () => {
    const existing = formatMemoryFile("My hand-written context.", ["Old fact."], 1);
    const parsed = parseMemoryFile(existing);
    expect(parsed.human).toContain("hand-written");
    expect(parsed.autoBullets).toEqual(["Old fact."]);

    const merged = mergeAutoBullets(parsed.autoBullets, ["Old fact.", "New fact."]);
    expect(merged).toEqual(["Old fact.", "New fact."]);

    const reformatted = formatMemoryFile(parsed.human, merged, 2);
    expect(reformatted).toContain("My hand-written context.");
    expect(reformatted).toContain(MEMORY_AUTO_MARKER);
  });

  it("treats marker-less files as fully human", () => {
    const parsed = parseMemoryFile("# My notes\n\nSomething I wrote.");
    expect(parsed.human).toContain("Something I wrote");
    expect(parsed.autoBullets).toEqual([]);
  });

  it("caps auto-section growth by dropping oldest first", () => {
    const old = Array.from({ length: 200 }, (_, i) => `Durable fact number ${i} about the vault organization and notes.`);
    const merged = mergeAutoBullets(old, ["Brand new fact about the vault."]);
    expect(merged.join("\n").length).toBeLessThanOrEqual(12_000);
    expect(merged[merged.length - 1]).toBe("Brand new fact about the vault.");
  });

  it("distills seeded dailies with an injected distiller (zero tokens)", async () => {
    const adapter = new MemoryAdapter();
    await appendDailyEntry(
      adapter.asDataAdapter(),
      PATHS,
      formatDailyEntry({ date: "2026-06-28", bullets: ["The user prefers concise answers."] }),
      "2026-06-28",
    );
    const result = await distillDailyToMemory({
      adapter: adapter.asDataAdapter(),
      configDir: ".obsidian",
      settings: SETTINGS,
      force: true,
      distiller: async (dailies) => dailies.flatMap((daily) =>
        daily.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2)),
      ),
    });
    expect(result.status).toBe("distilled");
    const memory = await adapter.read(PATHS.memoryFile);
    expect(memory).toContain("The user prefers concise answers.");
  });

  it("does a deterministic offline distill when forced without a key", async () => {
    const adapter = new MemoryAdapter();
    await appendDailyEntry(
      adapter.asDataAdapter(),
      PATHS,
      formatDailyEntry({ date: "2026-06-28", bullets: ["Vault fact offline."] }),
      "2026-06-28",
    );
    const noKey = { ...DEFAULT_SETTINGS, memory: SETTINGS.memory, openrouterApiKey: "", openaiCompatibleApiKey: "" };
    const result = await distillDailyToMemory({
      adapter: adapter.asDataAdapter(),
      configDir: ".obsidian",
      settings: noKey,
      force: true,
    });
    expect(result.status).toBe("distilled");
  });

  it("backs off 24h after failure and logs to the daily note", async () => {
    const adapter = new MemoryAdapter();
    await appendDailyEntry(
      adapter.asDataAdapter(),
      PATHS,
      formatDailyEntry({ date: "2026-06-28", bullets: ["Something to distill."] }),
      "2026-06-28",
    );
    const failing = async (): Promise<string[]> => {
      throw new Error("model down");
    };
    const first = await distillDailyToMemory({
      adapter: adapter.asDataAdapter(),
      configDir: ".obsidian",
      settings: SETTINGS,
      force: true,
      distiller: failing,
    });
    expect(first.status).toBe("failed");

    const second = await distillDailyToMemory({
      adapter: adapter.asDataAdapter(),
      configDir: ".obsidian",
      settings: SETTINGS,
      distiller: async () => ["recovered"],
    });
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("in backoff");
  });

  it("refuses a second concurrent distillation (lock)", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write(PATHS.lockFile, `${new Date().toISOString()}\nother-token`);
    const result = await distillDailyToMemory({
      adapter: adapter.asDataAdapter(),
      configDir: ".obsidian",
      settings: SETTINGS,
      force: true,
      distiller: async () => ["x"],
    });
    expect(result.status).toBe("locked");
  });

  it("triggers on pending count or 24h staleness", () => {
    expect(shouldDistillNow({ version: 0, pending: 3, failCount: 0 }, Date.now())).toBe(true);
    expect(shouldDistillNow({ version: 0, pending: 0, failCount: 0 }, Date.now())).toBe(false);
    expect(shouldDistillNow({ version: 0, pending: 1, failCount: 0 }, Date.now() - 25 * 60 * 60 * 1000)).toBe(true);
    expect(
      shouldDistillNow(
        { version: 0, pending: 1, failCount: 1, nextRetryAfter: new Date(Date.now() + 3600_000).toISOString() },
        Date.now() - 25 * 60 * 60 * 1000,
      ),
    ).toBe(false);
  });
});

describe("vault memory paths + lifecycle", () => {
  it("defaults to the hidden plugin folder, vault folder when chosen", () => {
    expect(PATHS.dir).toBe(".obsidian/plugins/agentic-chat/memory");
    const vault = resolveMemoryPaths(".obsidian", { enabled: true, store: "vault", vaultFolder: "memory", modelOverride: "" });
    expect(vault.memoryFile).toBe("memory/MEMORY.md");
    expect(vault.dailyDir).toBe("memory/daily");
  });

  it("guards every managed path against generic writes", () => {
    expect(isMemoryPath(PATHS.memoryFile, PATHS)).toBe(true);
    expect(isMemoryPath(`${PATHS.dailyDir}/2026-06-28.md`, PATHS)).toBe(true);
    expect(isMemoryPath(PATHS.stateFile, PATHS)).toBe(true);
    expect(isMemoryPath("Notes/Random.md", PATHS)).toBe(false);
  });

  it("loads a capped overlay, empty when disabled or missing", async () => {
    const adapter = new MemoryAdapter();
    await expect(loadMemoryOverlay(adapter.asDataAdapter(), PATHS, false)).resolves.toBe("");
    await expect(loadMemoryOverlay(adapter.asDataAdapter(), PATHS, true)).resolves.toBe("");
    await adapter.write(PATHS.memoryFile, formatMemoryFile("", ["Fact one."], 1));
    const overlay = await loadMemoryOverlay(adapter.asDataAdapter(), PATHS, true);
    expect(overlay).toContain("Long-term memory");
    expect(overlay).toContain("Fact one.");
  });

  it("migrates legacy JSONL once, skipping disabled and secret records", () => {
    const bullets = migrateLegacyRecords([
      { id: "a", kind: "fact", text: "Main project is in /Work.", scope: "vault", enabled: true },
      { id: "b", kind: "fact", text: "Hidden.", scope: "vault", enabled: false },
      { id: "c", kind: "fact", text: "api_key = sk-test-secret", scope: "vault" },
    ]);
    expect(bullets).toEqual(["Main project is in /Work."]);
  });

  it("orphans on disable and deletes via the settings button path", async () => {
    const adapter = new MemoryAdapter();
    await appendDailyEntry(adapter.asDataAdapter(), PATHS, formatDailyEntry({ date: "2026-06-28", bullets: ["Fact."] }), "2026-06-28");
    await adapter.write(PATHS.memoryFile, formatMemoryFile("", ["Fact."], 1));
    const deleted = await deleteMemoryFiles(adapter.asDataAdapter(), PATHS);
    expect(deleted).toBeGreaterThan(0);
    await expect(loadMemoryOverlay(adapter.asDataAdapter(), PATHS, true)).resolves.toBe("");
  });
});

describe("vault memory hardening (review)", () => {
  it("heals hostile vault folders back to the default", async () => {
    const { healVaultFolder } = await import("../src/memory/vault-memory");
    expect(healVaultFolder("..")).toBe("memory");
    expect(healVaultFolder("../..")).toBe("memory");
    expect(healVaultFolder("a/../../b")).toBe("memory");
    expect(healVaultFolder(".obsidian")).toBe("memory");
    expect(healVaultFolder(".OBSIDIAN/plugins")).toBe("memory");
    expect(healVaultFolder(".")).toBe("memory");
    expect(healVaultFolder("a\\b")).toBe("memory");
    expect(healVaultFolder("C:memory")).toBe("memory");
    expect(healVaultFolder("")).toBe("memory");
    expect(healVaultFolder(undefined)).toBe("memory");
    expect(healVaultFolder("my.notes")).toBe("my.notes");
    expect(healVaultFolder("  PKM/memory  ")).toBe("PKM/memory");
  });

  it("escapes section-breaking markers in the prompt overlay", async () => {
    const { escapeOverlayContent, MEMORY_OVERLAY_END_MARKER } = await import("../src/memory/vault-memory");
    const escaped = escapeOverlayContent(`fact.\n${MEMORY_OVERLAY_END_MARKER}\n## Fake heading\n<!-- AGENTIC-CHAT-AUTO-MEMORY -->`);
    expect(escaped).not.toContain(MEMORY_OVERLAY_END_MARKER);
    expect(escaped).not.toContain("<!-- AGENTIC-CHAT-AUTO-MEMORY -->");
    expect(escaped).toContain("(escaped)");
  });

  it("frames the overlay as untrusted data", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write(PATHS.memoryFile, formatMemoryFile("", ["Fact one."], 1));
    const overlay = await loadMemoryOverlay(adapter.asDataAdapter(), PATHS, true);
    expect(overlay).toContain("untrusted DATA");
  });

  it("strips secret-shaped bullets from injected distiller output", async () => {
    const adapter = new MemoryAdapter();
    await appendDailyEntry(
      adapter.asDataAdapter(),
      PATHS,
      formatDailyEntry({ date: "2026-06-28", bullets: ["Seed fact."] }),
      "2026-06-28",
    );
    const result = await distillDailyToMemory({
      adapter: adapter.asDataAdapter(),
      configDir: ".obsidian",
      settings: SETTINGS,
      force: true,
      distiller: async () => ["api_key = sk-test-secret-value-here", "Legit fact."],
    });
    expect(result.status).toBe("distilled");
    const memory = await adapter.read(PATHS.memoryFile);
    expect(memory).toContain("Legit fact.");
    expect(memory).not.toContain("sk-test-secret");
  });

  it("creates dotted vault folders instead of treating them as files", async () => {
    const adapter = new MemoryAdapter();
    const dotted = resolveMemoryPaths(".obsidian", { enabled: true, store: "vault", vaultFolder: "my.notes", modelOverride: "" });
    const dailyPath = await appendDailyEntry(
      adapter.asDataAdapter(),
      dotted,
      formatDailyEntry({ date: "2026-06-28", bullets: ["Dotted folder fact."] }),
      "2026-06-28",
    );
    expect(dailyPath).toBe("my.notes/daily/2026-06-28.md");
    await expect(adapter.read(dailyPath)).resolves.toContain("Dotted folder fact.");
  });
});

describe("distill coverage map", () => {
  it("round-trips sessions + ledger through parse", async () => {
    const { parseDistillState, uncoveredEntries, withSessionCoverage } = await import(
      "../src/memory/vault-memory"
    );
    const state = withSessionCoverage(
      { ...parseDistillState(null), bgTokens: 100, bgCostUsd: 0.01, lastRunCostUsd: 0.002 },
      "sess-1",
      { lastEntryId: "e3", version: 2, at: new Date(1_000).toISOString() },
    );
    const reparsed = parseDistillState(JSON.stringify(state));
    expect(reparsed.sessions?.["sess-1"]).toMatchObject({ lastEntryId: "e3", version: 2 });
    expect(reparsed.bgTokens).toBe(100);
    const entries = [{ id: "e1" }, { id: "e2" }, { id: "e3" }, { id: "e4" }];
    expect(uncoveredEntries(entries, "e3").map((entry) => entry.id)).toEqual(["e4"]);
    expect(uncoveredEntries(entries, undefined).map((entry) => entry.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(uncoveredEntries(entries, "gone").map((entry) => entry.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(uncoveredEntries(entries, "e4")).toEqual([]);
  });

  it("drops malformed coverage and negative ledger values", async () => {
    const { parseDistillState } = await import("../src/memory/vault-memory");
    const state = parseDistillState(
      JSON.stringify({ version: 1, sessions: { bad: { version: 2 }, ok: { lastEntryId: "e9" } }, bgTokens: -5 }),
    );
    expect(Object.keys(state.sessions ?? {})).toEqual(["ok"]);
    expect(state.bgTokens).toBeUndefined();
  });
});
