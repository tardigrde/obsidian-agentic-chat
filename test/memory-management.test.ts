import { describe, expect, it } from "vitest";
import {
  ageStaleMemories,
  clearMemoryRecords,
  consolidateDuplicateMemories,
  deleteMemory,
  explainMemoryProvenance,
  exportMemoryRecords,
  forgetMemory,
  memoryRecordsToJsonl,
  migrateMemoryRecords,
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
      record({ id: "mem-project", scope: "project" }),
      record({ id: "mem-other", text: "The user prefers detailed answers." }),
    ]);

    expect(result.consolidations).toEqual([]);
    expect(result.records.map((item) => item.id).sort()).toEqual(["mem-other", "mem-project", "mem-vault"]);
  });

  it("ages stale enabled memories without forgetting them", () => {
    const result = ageStaleMemories(
      [
        record({ id: "mem-old", createdAt: new Date(OLD).toISOString(), confidence: 0.9 }),
        record({ id: "mem-fresh", createdAt: new Date(NOW).toISOString(), confidence: 0.9 }),
      ],
      { now: NOW, staleAfterDays: 90 },
    );

    expect(result.agedIds).toEqual(["mem-old"]);
    expect(result.records.find((item) => item.id === "mem-old")).toMatchObject({
      stale: true,
      confidence: 0.4,
      tags: ["stale"],
    });
    expect(result.records.find((item) => item.id === "mem-fresh")?.stale).toBeUndefined();
  });

  it("forgets and deletes memories as distinct operations", () => {
    const forgotten = forgetMemory([record()], "mem-1", { now: NOW, reason: "user request" });

    expect(forgotten.forgotten).toMatchObject({
      id: "mem-1",
      enabled: false,
      forgottenAt: new Date(NOW).toISOString(),
      forgetReason: "user request",
    });

    const deleted = deleteMemory(forgotten.records, "mem-1");
    expect(deleted.deleted?.id).toBe("mem-1");
    expect(deleted.records).toEqual([]);
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

  it("migrates legacy records to explicit provenance and enabled state", () => {
    expect(migrateMemoryRecords([record({ enabled: undefined, source: "[[Notes/Legacy.md]]" })], { now: NOW })).toEqual([
      expect.objectContaining({
        enabled: true,
        provenance: [{ source: "[[Notes/Legacy.md]]", extractedAt: new Date(NOW).toISOString() }],
      }),
    ]);
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
