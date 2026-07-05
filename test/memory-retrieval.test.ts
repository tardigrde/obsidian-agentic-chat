import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App, DataAdapter } from "obsidian";
import { addEvidenceSource, createEvidenceLedger } from "../src/retrieval/evidence-ledger";
import {
  formatMemorySearchResponse,
  loadMemoryRecords,
  memoryCitations,
  parseMemoryRecords,
  searchMemories,
} from "../src/memory/memory";
import { createMemoryTools } from "../src/tools/memory-tools";
import { MemoryAdapter } from "./helpers/memory-adapter";
import { FAKE_MEMORY_FIXTURE, fakeMemoryJsonl } from "./helpers/memory-fixtures";

const MEMORY_PATH = ".obsidian/plugins/agentic-chat/memory/memories.jsonl";

async function run(tool: AgentTool, params: unknown): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await tool.execute("call-1", params as never);
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return { text, details: (result.details ?? {}) as Record<string, unknown> };
}

function appWithAdapter(adapter: DataAdapter): App {
  return { vault: { adapter, configDir: ".obsidian" } } as unknown as App;
}

describe("memory retrieval", () => {
  it("parses fake memory JSONL, skips invalid rows, and keeps the last duplicate id", () => {
    const records = parseMemoryRecords(
      [
        JSON.stringify({ id: "mem-1", kind: "fact", scope: "vault", text: "first" }),
        "not json",
        JSON.stringify({ id: "bad", kind: "unknown", text: "bad" }),
        JSON.stringify({ id: "mem-1", kind: "fact", scope: "vault", text: "replacement" }),
      ].join("\n"),
    );

    expect(records).toEqual([
      expect.objectContaining({
        id: "mem-1",
        text: "replacement",
      }),
    ]);
  });

  it("retrieves citable memories with lexical matching and scope filters", () => {
    const response = searchMemories(
      { query: "concise citations embeddings gpu", maxResults: 10 },
      { records: FAKE_MEMORY_FIXTURE },
    );

    expect(response.matches.map((match) => match.record.id)).toEqual(["mem-pref-concise", "mem-fact-embeddings"]);
    expect(response.filteredCount).toBe(1);
    expect(response.disabledCount).toBe(1);
    expect(memoryCitations(response.matches)).toEqual([
      "[[Notes/Preferences.md#Style|Style preference]]",
      "[Embedding note](https://example.com/embedding-costs)",
    ]);
    expect(formatMemorySearchResponse({ query: "concise citations embeddings gpu" }, response)).toContain(
      "The user prefers concise answers with exact source citations.",
    );
  });

  it("honors explicit kind and scope limits", () => {
    const response = searchMemories(
      { query: "embedding expensive gpu", kind: "fact", scope: "vault" },
      { records: FAKE_MEMORY_FIXTURE },
    );

    expect(response.matches.map((match) => match.record.id)).toEqual(["mem-fact-embeddings"]);
    expect(response.matches[0]?.record.kind).toBe("fact");
    expect(response.matches[0]?.record.scope).toBe("vault");
  });

  it("feeds memory citations into the evidence ledger without inventing source types", () => {
    const response = searchMemories(
      { query: "concise citations" },
      { records: FAKE_MEMORY_FIXTURE },
    );
    const citation = memoryCitations(response.matches)[0];
    const match = response.matches[0];
    if (!citation || !match) throw new Error("Expected citable memory fixture match.");
    let ledger = createEvidenceLedger({ sessionId: "memory-test", now: () => Date.UTC(2026, 5, 26, 10, 0, 0) });

    const added = addEvidenceSource(
      ledger,
      {
        reference: citation,
        excerpt: match.record.text,
        metadata: { memoryId: match.record.id },
      },
      { now: () => Date.UTC(2026, 5, 26, 10, 0, 1) },
    );
    ledger = added.ledger;

    expect(added.redacted).toBe(false);
    expect(ledger.sources[0]).toMatchObject({
      citation: "[[Notes/Preferences.md#Style|Style preference]]",
      metadata: { memoryId: "mem-pref-concise" },
    });
  });

  it("loads plugin-managed memory JSONL and exposes it through explicit search_memory tool calls", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write(MEMORY_PATH, fakeMemoryJsonl());
    const [tool] = createMemoryTools(appWithAdapter(adapter.asDataAdapter()));
    if (!tool) throw new Error("Expected search_memory tool.");

    const { text, details } = await run(tool, { query: "embedding gpu citations", maxResults: 5 });

    expect(text).toContain("Memory search: embedding gpu citations");
    expect(text).toContain("Large vault embedding generation can be expensive without GPU acceleration.");
    expect(text).toContain("The user prefers concise answers with exact source citations.");
    expect(text).not.toContain("Project-only memory");
    expect(text).not.toContain("Disabled memory");
    expect(details).toMatchObject({
      memoryPath: MEMORY_PATH,
      query: "embedding gpu citations",
      returned: 2,
      totalMatches: 2,
      filteredCount: 1,
      disabledCount: 1,
      memoryIds: ["mem-fact-embeddings", "mem-pref-concise"],
      citations: [
        "[Embedding note](https://example.com/embedding-costs)",
        "[[Notes/Preferences.md#Style|Style preference]]",
      ],
    });
  });

  it("returns an explicit empty result instead of silently injecting memories", async () => {
    const adapter = new MemoryAdapter();
    const [tool] = createMemoryTools(appWithAdapter(adapter.asDataAdapter()));
    if (!tool) throw new Error("Expected search_memory tool.");

    const { text, details } = await run(tool, { query: "anything" });

    expect(text).toContain("No matching stored memories");
    expect(text).toContain("only searched when search_memory is called");
    expect(details).toMatchObject({ returned: 0, totalMatches: 0 });
    await expect(loadMemoryRecords(adapter.asDataAdapter(), MEMORY_PATH)).resolves.toEqual([]);
  });
});
