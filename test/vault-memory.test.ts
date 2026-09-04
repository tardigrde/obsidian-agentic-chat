import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  appendDailyEntry,
  dailyPathForDate,
  deleteMemoryFiles,
  formatDailyEntry,
  formatMemoryFile,
  isMemoryPath,
  loadMemoryOverlay,
  mergeAutoBullets,
  migrateLegacyRecords,
  parseMemoryFile,
  resolveMemoryPaths,
  shouldCaptureSession,
  shouldDistillNow,
  extractDailyBullets,
  MEMORY_AUTO_MARKER,
  type VaultMemorySettings,
} from "../src/memory/vault-memory";
import { distillDailyToMemory, flushSessionToDaily } from "../src/memory/distill-runtime";
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
    messages.push(userMessage(`User question number ${i} about the vault structure and notes organization`));
    messages.push(assistantMessage(`Assistant answer number ${i} with some detail about notes and folders`));
  }
  return messages;
}

describe("vault memory Tier-1", () => {
  it("skips tiny sessions without spending tokens", () => {
    expect(shouldCaptureSession([]).capture).toBe(false);
    expect(shouldCaptureSession([userMessage("hi"), assistantMessage("hello there")]).capture).toBe(false);
    const gate = shouldCaptureSession(session(3));
    expect(gate.capture).toBe(true);
  });

  it("extracts deterministic bullets and filters secrets", () => {
    const bullets = extractDailyBullets([
      userMessage("Please remember that my main project is in /Work and I prefer concise answers."),
      assistantMessage("Noted."),
      userMessage("Also remember that the api_key = sk-test-secret-value-here for later use please."),
      assistantMessage("Hmm."),
      userMessage("My editor font size is 14 for reading notes comfortably every day."),
    ]);
    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets.join("\n")).toContain("concise");
    expect(bullets.join("\n")).not.toContain("sk-test");
  });

  it("appends Tier-1 entries to today's daily note", async () => {
    const adapter = new MemoryAdapter();
    const result = await flushSessionToDaily({
      adapter: adapter.asDataAdapter(),
      configDir: ".obsidian",
      settings: SETTINGS,
      messages: session(3),
      sessionId: "session-1",
    });
    expect(result.status).toBe("appended");
    const daily = await adapter.read(dailyPathForDate(PATHS, new Date().toISOString().slice(0, 10)));
    expect(daily).toContain("session-1");
  });

  it("skips flush when disabled", async () => {
    const adapter = new MemoryAdapter();
    const result = await flushSessionToDaily({
      adapter: adapter.asDataAdapter(),
      configDir: ".obsidian",
      settings: { ...DEFAULT_SETTINGS },
      messages: session(3),
    });
    expect(result.status).toBe("disabled");
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
    await adapter.write(PATHS.lockFile, new Date().toISOString());
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
