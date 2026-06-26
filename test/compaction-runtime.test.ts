import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { AgentCompactionRuntime } from "../src/agent/compaction-runtime";
import { getCompactedUsage, isSummaryMessage } from "../src/agent/compaction";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { parseSessionEntries } from "../src/session/jsonl";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { MemoryAdapter } from "./helpers/memory-adapter";

const DEFAULTS = { provider: "openrouter", modelId: "test/model", thinkingLevel: "off" as const };

function settings(overrides: Partial<AgenticChatSettings> = {}): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    openrouterApiKey: "test-key",
    openrouterModel: "test/model",
    ...overrides,
    compaction: { ...DEFAULT_SETTINGS.compaction, ...(overrides.compaction ?? {}) },
  };
}

function usage(totalTokens: number, totalCost = 0, input = totalTokens): Usage {
  return {
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
  };
}

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistant(text: string, tokenUsage: Usage): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: tokenUsage,
    stopReason: "stop",
    timestamp: 2,
  } as AgentMessage;
}

async function setup(
  options: {
    settings?: AgenticChatSettings;
    summarize?: () => Promise<string>;
  } = {},
): Promise<{ adapter: MemoryAdapter; manager: ObsidianSessionManager; runtime: AgentCompactionRuntime; path: string }> {
  const adapter = new MemoryAdapter();
  const manager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  const info = await manager.createSession(DEFAULTS);
  const runtime = new AgentCompactionRuntime({
    getSettings: () => options.settings ?? settings(),
    sessionManager: manager,
    summarize: options.summarize ?? (async () => "Summary of earlier turns."),
  });
  return { adapter, manager, runtime, path: info.path };
}

function largeTranscript(): AgentMessage[] {
  return [
    user("u".repeat(4_000)),
    assistant("a".repeat(4_000), usage(10, 0.01)),
    user("v".repeat(4_000)),
    assistant("b".repeat(4_000), usage(20, 0.02)),
    user("w".repeat(4_000)),
    assistant("c".repeat(4_000), usage(30, 0.03)),
    user("x".repeat(4_000)),
    assistant("d".repeat(4_000), usage(40, 0.04)),
    user("y".repeat(4_000)),
    assistant("e".repeat(4_000), usage(1_000, 0.05)),
  ];
}

describe("AgentCompactionRuntime", () => {
  it("summarizes, carries dropped usage, rewrites the session, and returns the compacted transcript", async () => {
    const { adapter, runtime, path } = await setup();
    const compacted = await runtime.compact(largeTranscript(), 1_000);

    expect(compacted).not.toBeNull();
    expect(isSummaryMessage(compacted![0])).toBe(true);
    expect(JSON.stringify(compacted![0])).toContain("Summary of earlier turns.");
    // With a 1k-token context window and default 30% keep budget, the planner
    // falls back to keeping only the final turn, so usage from four assistant
    // turns is carried onto the replacement summary.
    expect(getCompactedUsage(compacted![0])).toMatchObject({ totalTokens: 100, cost: { total: 0.1 } });
    expect(compacted!.slice(1).map((message) => message.role)).toEqual(["user", "assistant"]);

    const entries = parseSessionEntries(adapter.files.get(path) ?? "");
    expect(entries.filter((entry) => entry.type === "message")).toHaveLength(compacted!.length);
  });

  it("returns null and leaves the session untouched when no compaction plan is needed", async () => {
    const { adapter, runtime, path } = await setup();
    const before = adapter.files.get(path);

    const compacted = await runtime.compact([user("short"), assistant("ok", usage(1))], 400);

    expect(compacted).toBeNull();
    expect(adapter.files.get(path)).toBe(before);
  });

  it("returns null and leaves the session untouched when summarization yields no text", async () => {
    const { adapter, runtime, path } = await setup({ summarize: async () => "   " });
    const before = adapter.files.get(path);

    const compacted = await runtime.compact(largeTranscript(), 400);

    expect(compacted).toBeNull();
    expect(adapter.files.get(path)).toBe(before);
  });
});
