import { describe, expect, it } from "vitest";
import { ToolArtifactStore } from "../src/artifacts/tool-artifact-store";
import { MemoryAdapter } from "./helpers/memory-adapter";

describe("ToolArtifactStore", () => {
  it("writes and reads plugin-managed artifacts through the DataAdapter", async () => {
    const adapter = new MemoryAdapter();
    const store = new ToolArtifactStore(adapter.asDataAdapter(), ".obsidian/plugins/agentic-chat/artifacts");

    const metadata = await store.writeArtifact({
      label: "Team Docs: jira_search",
      sourceToolName: "mcp__team_docs__call_readonly_tool",
      text: "large result",
      contentType: "application/json",
    });
    const read = await store.readArtifact(metadata.id);

    expect(metadata).toMatchObject({
      label: "Team Docs: jira_search",
      sourceToolName: "mcp__team_docs__call_readonly_tool",
      contentType: "application/json",
      charLength: "large result".length,
    });
    expect(read).toEqual({ metadata, text: "large result" });
    expect(await adapter.exists(".obsidian/plugins/agentic-chat/artifacts")).toBe(true);
  });

  it("persists optional dedupe metadata and finds artifacts by dedupe key", async () => {
    const adapter = new MemoryAdapter();
    const store = new ToolArtifactStore(adapter.asDataAdapter(), ".obsidian/plugins/agentic-chat/artifacts");

    const metadata = await store.writeArtifact({
      label: "Source: Research Doc",
      sourceToolName: "agentic-chat.source-import",
      text: "source text",
      contentType: "text/markdown",
      dedupKey: "source:https://example.com/research:abc123",
      sourceUrl: "https://example.com/research",
      sourceKind: "web",
      sourceTextHash: "abc123",
    });

    await expect(store.findArtifactByDedupKey("source:https://example.com/research:abc123")).resolves.toEqual({
      metadata,
      text: "source text",
    });
    await expect(store.findArtifactBySourceTextHash("abc123")).resolves.toEqual({
      metadata,
      text: "source text",
    });
    await expect(store.findArtifactByDedupKey("source:missing")).resolves.toBeNull();
    await expect(store.findArtifactBySourceTextHash("missing")).resolves.toBeNull();
    await expect(store.listArtifacts()).resolves.toEqual([metadata]);
  });

  it("cleans up expired, excess, and orphaned artifact files", async () => {
    const adapter = new MemoryAdapter();
    let now = Date.UTC(2026, 5, 24, 12, 0, 0);
    const store = new ToolArtifactStore(adapter.asDataAdapter(), ".obsidian/plugins/agentic-chat/artifacts", {
      maxArtifactAgeMs: 1_000,
      maxArtifactCount: 2,
      now: () => now,
    });

    const old = await store.writeArtifact({ label: "old", sourceToolName: "tool", text: "old" });
    now += 500;
    const firstKept = await store.writeArtifact({ label: "first", sourceToolName: "tool", text: "first" });
    now += 500;
    const secondKept = await store.writeArtifact({ label: "second", sourceToolName: "tool", text: "second" });
    await adapter.write(".obsidian/plugins/agentic-chat/artifacts/orphan.txt", "orphan");
    now += 1_500;

    await store.cleanupArtifacts();

    await expect(store.readArtifact(old.id)).rejects.toThrow(/Not found/);
    await expect(store.readArtifact(firstKept.id)).rejects.toThrow(/Not found/);
    await expect(store.readArtifact(secondKept.id)).rejects.toThrow(/Not found/);
    expect(await adapter.exists(".obsidian/plugins/agentic-chat/artifacts/orphan.txt")).toBe(false);
  });

  it("keeps only the newest artifacts when count retention is exceeded", async () => {
    const adapter = new MemoryAdapter();
    let now = Date.UTC(2026, 5, 24, 12, 0, 0);
    const store = new ToolArtifactStore(adapter.asDataAdapter(), ".obsidian/plugins/agentic-chat/artifacts", {
      maxArtifactAgeMs: 60_000,
      maxArtifactCount: 2,
      now: () => now,
    });

    const first = await store.writeArtifact({ label: "first", sourceToolName: "tool", text: "first" });
    now += 1_000;
    const second = await store.writeArtifact({ label: "second", sourceToolName: "tool", text: "second" });
    now += 1_000;
    const third = await store.writeArtifact({ label: "third", sourceToolName: "tool", text: "third" });

    await expect(store.readArtifact(first.id)).rejects.toThrow(/Not found/);
    await expect(store.readArtifact(second.id)).resolves.toMatchObject({ text: "second" });
    await expect(store.readArtifact(third.id)).resolves.toMatchObject({ text: "third" });
  });

  it("keeps pinned artifacts during routine cleanup until they are explicitly unpinned", async () => {
    const adapter = new MemoryAdapter();
    let now = Date.UTC(2026, 5, 24, 12, 0, 0);
    const store = new ToolArtifactStore(adapter.asDataAdapter(), ".obsidian/plugins/agentic-chat/artifacts", {
      maxArtifactAgeMs: 1_000,
      maxArtifactCount: 1,
      now: () => now,
    });

    const pinned = await store.writeArtifact({ label: "pinned", sourceToolName: "tool", text: "pinned", pinned: true });
    now += 100;
    const old = await store.writeArtifact({ label: "old", sourceToolName: "tool", text: "old" });
    now += 600;
    const newest = await store.writeArtifact({ label: "newest", sourceToolName: "tool", text: "newest" });
    now += 500;

    await store.cleanupArtifacts();

    await expect(store.readArtifact(pinned.id)).resolves.toMatchObject({ text: "pinned" });
    await expect(store.readArtifact(old.id)).rejects.toThrow(/Not found/);
    await expect(store.readArtifact(newest.id)).resolves.toMatchObject({ text: "newest" });
    await expect(store.listArtifacts()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: pinned.id, pinned: true })]),
    );

    await expect(store.pinArtifact(pinned.id, false)).resolves.toMatchObject({ id: pinned.id, pinned: false });
    await store.cleanupArtifacts();

    await expect(store.readArtifact(pinned.id)).rejects.toThrow(/Not found/);
    await expect(store.readArtifact(newest.id)).resolves.toMatchObject({ text: "newest" });
  });

  it("prunes oldest unpinned artifacts when total byte retention is exceeded", async () => {
    const adapter = new MemoryAdapter();
    let now = Date.UTC(2026, 5, 24, 12, 0, 0);
    const store = new ToolArtifactStore(adapter.asDataAdapter(), ".obsidian/plugins/agentic-chat/artifacts", {
      maxArtifactAgeMs: 60_000,
      maxArtifactCount: 10,
      maxTotalArtifactBytes: 14,
      now: () => now,
    });

    const pinned = await store.writeArtifact({
      label: "pinned",
      sourceToolName: "tool",
      text: "pinned-10!",
      pinned: true,
    });
    now += 1_000;
    const oldest = await store.writeArtifact({ label: "oldest", sourceToolName: "tool", text: "old!" });
    now += 1_000;
    const middle = await store.writeArtifact({ label: "middle", sourceToolName: "tool", text: "mid!" });
    now += 1_000;
    const newest = await store.writeArtifact({ label: "newest", sourceToolName: "tool", text: "new!" });

    await store.cleanupArtifacts();

    await expect(store.readArtifact(pinned.id)).resolves.toMatchObject({ text: "pinned-10!" });
    await expect(store.readArtifact(oldest.id)).rejects.toThrow(/Not found/);
    await expect(store.readArtifact(middle.id)).rejects.toThrow(/Not found/);
    await expect(store.readArtifact(newest.id)).resolves.toMatchObject({ text: "new!" });
  });

  it("keeps artifacts referenced by saved sessions during routine cleanup", async () => {
    const adapter = new MemoryAdapter();
    let now = Date.UTC(2026, 5, 24, 12, 0, 0);
    const referencedIds = new Set<string>();
    const store = new ToolArtifactStore(adapter.asDataAdapter(), ".obsidian/plugins/agentic-chat/artifacts", {
      maxArtifactAgeMs: 1_000,
      maxArtifactCount: 1,
      maxTotalArtifactBytes: 14,
      referencedArtifactIds: async () => referencedIds,
      now: () => now,
    });

    const referenced = await store.writeArtifact({ label: "referenced", sourceToolName: "tool", text: "referenced!" });
    referencedIds.add(referenced.id);
    now += 100;
    const old = await store.writeArtifact({ label: "old", sourceToolName: "tool", text: "old" });
    now += 600;
    const newest = await store.writeArtifact({ label: "newest", sourceToolName: "tool", text: "new" });
    now += 500;

    await store.cleanupArtifacts();

    await expect(store.readArtifact(referenced.id)).resolves.toMatchObject({ text: "referenced!" });
    await expect(store.readArtifact(old.id)).rejects.toThrow(/Not found/);
    await expect(store.readArtifact(newest.id)).resolves.toMatchObject({ text: "new" });

    referencedIds.clear();
    await store.cleanupArtifacts();

    await expect(store.readArtifact(referenced.id)).rejects.toThrow(/Not found/);
    await expect(store.readArtifact(newest.id)).resolves.toMatchObject({ text: "new" });
  });

  it("records UTF-8 byte length separately from character length", async () => {
    const adapter = new MemoryAdapter();
    const store = new ToolArtifactStore(adapter.asDataAdapter(), ".obsidian/plugins/agentic-chat/artifacts", {
      maxTotalArtifactBytes: 100,
    });

    const metadata = await store.writeArtifact({ label: "unicode", sourceToolName: "tool", text: "ééé" });
    const read = await store.readArtifact(metadata.id);

    expect(metadata).toMatchObject({ charLength: 3, byteLength: 6 });
    expect(read.metadata).toMatchObject({ charLength: 3, byteLength: 6 });
  });

  it("deletes a single artifact and clears all artifact files on demand", async () => {
    const adapter = new MemoryAdapter();
    const store = new ToolArtifactStore(adapter.asDataAdapter(), ".obsidian/plugins/agentic-chat/artifacts");
    const first = await store.writeArtifact({ label: "first", sourceToolName: "tool", text: "first" });
    const second = await store.writeArtifact({ label: "second", sourceToolName: "tool", text: "second" });
    await adapter.write(".obsidian/plugins/agentic-chat/artifacts/orphan.txt", "orphan");

    await expect(store.deleteArtifact(first.id)).resolves.toBe(true);
    await expect(store.deleteArtifact(first.id)).resolves.toBe(false);
    await expect(store.readArtifact(first.id)).rejects.toThrow(/Not found/);
    await expect(store.readArtifact(second.id)).resolves.toMatchObject({ text: "second" });

    await expect(store.clearArtifacts()).resolves.toBe(1);
    await expect(store.listArtifacts()).resolves.toEqual([]);
    expect(await adapter.exists(".obsidian/plugins/agentic-chat/artifacts/orphan.txt")).toBe(false);
  });
});
