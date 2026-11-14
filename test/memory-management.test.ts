import { describe, expect, it } from "vitest";
import {
  clearMemoryRecords,
  consolidateDuplicateMemories,
  explainMemoryProvenance,
  exportMemoryRecords,
  forgetMemory,
  memoryRecordsToJsonl,
  writeMemoryRecords,
} from "../src/memory/management";
import { loadMemoryRecords, type MemoryRecord } from "../src/memory/memory";
import { MemoryAdapter } from "./helpers/memory-adapter";

const MEMORY_PATH = ".obsidian/plugins/agentic-chat/memory/memories.jsonl";
const NOW = Date.UTC(2026, 5, 26, 12, 0, 0);
const OLD = Date.UTC(2025, 5, 26, 12, 0, 0);

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    kind: "preference",
    scope: "vault",
    text: "The user prefers concise answers.",
    enabled: true,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("memory management", () => {
  it("consolidates exact duplicate memories while preserving provenance", () => {
    const result = consolidateDuplicateMemories([
      record({
        id: "mem-old",
        source: "[[Notes/Old.md]]",
        createdAt: new Date(OLD).toISOString(),
        confidence: 0.4,
      }),
      record({
        id: "mem-new",
        source: "[[Notes/New.md]]",
        createdAt: new Date(NOW).toISOString(),
        tags: ["style"],
        confidence: 0.8,
      }),
    ]);

    expect(result.consolidations).toEqual([{ keptId: "mem-new", mergedIds: ["mem-old"] }]);
    expect(result.records).toEqual([
      expect.objectContaining({
        id: "mem-new",
        tags: ["style", "consolidated"],
        supersedes: ["mem-old"],
        confidence: 0.8,
        provenance: [
          { source: "[[Notes/New.md]]", extractedAt: new Date(NOW).toISOString() },
          { source: "[[Notes/Old.md]]", extractedAt: new Date(OLD).toISOString() },
        ],
      }),
    ]);
  });

  it("does not merge conflicting memories with different text or scope", () => {
    const result = consolidateDuplicateMemories([
      record({ id: "mem-vault" }),
      record({ id: "mem-global", scope: "global" }),
      record({ id: "mem-other", text: "The user prefers detailed answers." }),
    ]);

    expect(result.consolidations).toEqual([]);
    expect(result.records.map((item) => item.id).sort()).toEqual(["mem-global", "mem-other", "mem-vault"]);
  });

  it("forgets a memory without deleting its record", () => {
    const forgotten = forgetMemory([record()], "mem-1", { now: NOW, reason: "user request" });

    expect(forgotten.forgotten).toMatchObject({
      id: "mem-1",
      enabled: false,
      forgottenAt: new Date(NOW).toISOString(),
      forgetReason: "user request",
    });

    expect(forgotten.records).toHaveLength(1);
  });

  it("explains memory provenance and lifecycle metadata", () => {
    const explanation = explainMemoryProvenance(
      record({
        id: "mem-explain",
        source: "[[Notes/Preferences.md#Style|style]]",
        provenance: [{ source: "https://example.com/source", extractedAt: new Date(NOW).toISOString(), note: "approved" }],
        supersedes: ["mem-old"],
        stale: true,
        enabled: false,
        forgottenAt: new Date(NOW).toISOString(),
        forgetReason: "outdated",
        confidence: 0.4,
      }),
    );

    expect(explanation).toContain("Memory mem-explain");
    expect(explanation).toContain("[[Notes/Preferences.md#Style|style]]");
    expect(explanation).toContain("https://example.com/source");
    expect(explanation).toContain("Supersedes: mem-old");
    expect(explanation).toContain("Status: forgotten");
    expect(explanation).toContain("Reason: outdated");
  });

  it("rewrites managed memory JSONL through the adapter", async () => {
    const adapter = new MemoryAdapter();
    const records = [record({ id: "mem-a" }), record({ id: "mem-b", text: "The vault uses multilingual notes." })];

    await writeMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH, records);

    await expect(loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH)).resolves.toEqual(records);
  });

  it("exports and clears managed memory JSONL explicitly", async () => {
    const adapter = new MemoryAdapter();
    const records = [record({ id: "mem-a" }), record({ id: "mem-b", text: "The vault uses multilingual notes." })];
    await writeMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH, records);

    const exported = await exportMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH);
    expect(exported.records.map((item) => item.id)).toEqual(["mem-a", "mem-b"]);
    expect(exported.jsonl).toBe(memoryRecordsToJsonl(exported.records));
    await expect(clearMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH)).resolves.toBe(2);
    await expect(loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH)).resolves.toEqual([]);
    expect(await adapter.exists(MEMORY_PATH)).toBe(false);
  });
});

describe("writeMemoryRecords", () => {
  it("does not truncate the live memory file when a rewrite fails mid-write", async () => {
    const adapter = new MemoryAdapter();
    const before = memoryRecordsToJsonl([record()]);
    adapter.files.set(MEMORY_PATH, before);
    // Tear whichever file the rewrite writes first: the live file in place
    // (old behavior) or a staged temp file.
    const original = adapter.write.bind(adapter);
    let torn = false;
    adapter.write = async (target, data) => {
      if (!torn) {
        torn = true;
        adapter.files.set(target, data.slice(0, 5));
        throw new Error("disk full");
      }
      return original(target, data);
    };

    await expect(
      writeMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH, [record(), record({ id: "mem-2", text: "Second." })]),
    ).rejects.toThrow("disk full");

    expect(adapter.files.get(MEMORY_PATH)).toBe(before);
  });
});
