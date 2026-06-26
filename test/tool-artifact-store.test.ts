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
});
