import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { AgentCompactionRuntime, type SummarizeFn } from "../src/agent/compaction-runtime";
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
    summarize?: SummarizeFn | null;
    buildStreamFn?: () => StreamFn;
  } = {},
): Promise<{ adapter: MemoryAdapter; manager: ObsidianSessionManager; runtime: AgentCompactionRuntime; path: string }> {
  const adapter = new MemoryAdapter();
  const manager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  const info = await manager.createSession(DEFAULTS);
  const runtime = new AgentCompactionRuntime({
    getSettings: () => options.settings ?? settings(),
    sessionManager: manager,
    buildStreamFn: options.buildStreamFn,
    summarize: options.summarize === null ? undefined : options.summarize ?? (async () => "Summary of earlier turns."),
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

  it("archives the pre-compaction slice and embeds a recall index in the summary", async () => {
    const { manager, runtime } = await setup();
    const compacted = await runtime.compact(largeTranscript(), 1_000);
    expect(compacted).not.toBeNull();
    const archives = await manager.listCompactionArchives();
    expect(archives).toHaveLength(1);
    expect(archives[0]!.turns.length).toBeGreaterThan(0);
    const summaryText = JSON.stringify(compacted![0]);
    expect(summaryText).toContain("recall-index");
    expect(summaryText).toContain(archives[0]!.name);
  });

  it("preserves artifact cache references on the summary message", async () => {
    const { adapter, runtime, path } = await setup();
    const artifactResult = {
      role: "toolResult",
      toolName: "read",
      toolCallId: "read-1",
      isError: false,
      content: [
        {
          type: "text",
          text: "Read result: [src/large.txt lines 1-600](artifact:artifact-1)",
        },
      ],
      details: {
        action: "read",
        path: "src/large.txt",
        sourceArtifactId: "artifact-1",
        sourceArtifactCitation: "[src/large.txt lines 1-600](artifact:artifact-1)",
        cached: true,
      },
      timestamp: 2,
    } as unknown as AgentMessage;
    const transcript = [
      user("u".repeat(4_000)),
      artifactResult,
      assistant("a".repeat(4_000), usage(10, 0.01)),
      user("v".repeat(4_000)),
      assistant("b".repeat(4_000), usage(20, 0.02)),
      user("w".repeat(4_000)),
      assistant("c".repeat(4_000), usage(30, 0.03)),
      user("kept turn"),
      assistant("kept answer", usage(40, 0.04)),
    ];

    const compacted = await runtime.compact(transcript, 1_000);

    expect(compacted).not.toBeNull();
    expect(compacted![0]).toMatchObject({
      compactionManifest: {
        artifacts: [
          {
            id: "artifact-1",
            citation: "[src/large.txt lines 1-600](artifact:artifact-1)",
            sourceToolName: "read",
          },
        ],
      },
    });
    expect(JSON.stringify(compacted![0])).toContain("Preserved Artifact References");

    const persistedSummary = parseSessionEntries(adapter.files.get(path) ?? "").find((entry) => entry.type === "message");
    expect(persistedSummary).toMatchObject({
      type: "message",
      message: {
        compactionManifest: {
          artifacts: [{ id: "artifact-1" }],
        },
      },
    });
  });

  it("returns null and leaves the session untouched when no compaction plan is needed", async () => {
    const { adapter, runtime, path } = await setup();
    const before = adapter.files.get(path);

    const compacted = await runtime.compact([user("short"), assistant("ok", usage(1))], 400);

    expect(compacted).toBeNull();
    expect(adapter.files.get(path)).toBe(before);
  });

  it("returns a skipped reason when no compaction plan is available", async () => {
    const { runtime } = await setup();

    const result = await runtime.compactWithResult([user("short"), assistant("ok", usage(1))], 400);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "no_plan",
      message: expect.stringContaining("Need at least two user turns"),
    });
  });

  it("returns null and leaves the session untouched when summarization yields no text", async () => {
    const { adapter, runtime, path } = await setup({ summarize: async () => "   " });
    const before = adapter.files.get(path);

    const compacted = await runtime.compact(largeTranscript(), 400);

    expect(compacted).toBeNull();
    expect(adapter.files.get(path)).toBe(before);
  });

  it("returns a skipped reason when summarization yields no text", async () => {
    const { runtime } = await setup({ summarize: async () => "   " });

    const result = await runtime.compactWithResult(largeTranscript(), 400);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "summary_empty",
      message: expect.stringContaining("returned no text"),
    });
  });

  it("returns a skipped reason when summarization fails", async () => {
    const { adapter, runtime, path } = await setup({
      summarize: async () => {
        throw new Error("summary exploded");
      },
    });
    const before = adapter.files.get(path);

    const result = await runtime.compactWithResult(largeTranscript(), 400);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "summary_failed",
      message: expect.stringContaining("summary exploded"),
    });
    expect(adapter.files.get(path)).toBe(before);
  });

  it("passes manual compaction instructions to the summarizer", async () => {
    let received: string | undefined;
    const { runtime } = await setup({
      summarize: async (_messages, _signal, customInstructions) => {
        received = customInstructions;
        return "Focused summary.";
      },
    });

    const compacted = await runtime.compact(largeTranscript(), 100_000, {
      force: true,
      customInstructions: "preserve the roadmap decisions",
    });

    expect(compacted).not.toBeNull();
    expect(received).toBe("preserve the roadmap decisions");
  });

  it("summarizes model chunks through the configured stream function", async () => {
    let seenContext: Context | undefined;
    let seenOptions: SimpleStreamOptions | undefined;
    const streamFn = ((model: Model<"openai-completions">, context: Context, options?: SimpleStreamOptions) => {
      seenContext = context;
      seenOptions = options;
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Stream summary." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: usage(2),
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    }) as unknown as StreamFn;
    const { runtime } = await setup({
      summarize: null,
      buildStreamFn: () => streamFn,
    });

    const result = await runtime.compactWithResult(largeTranscript(), 128_000, {
      force: true,
      customInstructions: "preserve the roadmap decisions",
    });

    expect(result.status).toBe("compacted");
    expect(seenOptions).toMatchObject({
      apiKey: "test-key",
      headers: expect.objectContaining({
        "HTTP-Referer": "https://github.com/tardigrde/obsidian-agentic-chat",
        "X-Title": "Obsidian Agentic Chat",
      }),
    });
    expect(seenContext?.systemPrompt).toContain("context summarization assistant");
    expect(JSON.stringify(seenContext?.messages)).toContain("Additional instructions: preserve the roadmap decisions");
  });

  it("summarizes oversized compaction inputs in ordered chunks", async () => {
    const calls: Array<{ messages: number; previousSummary?: string }> = [];
    const { runtime } = await setup({
      summarize: async (messages, _signal, _customInstructions, previousSummary) => {
        calls.push({ messages: messages.length, previousSummary });
        return `summary-${calls.length}`;
      },
    });

    const compacted = await runtime.compact(largeTranscript(), 10_000, { force: true });

    expect(compacted).not.toBeNull();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0].previousSummary).toBeUndefined();
    expect(calls[1].previousSummary).toBe("summary-1");
    expect(JSON.stringify(compacted![0])).toContain("summary-");
  });
});

describe("AgentCompactionRuntime memory hooks", () => {
  it("survives a failing archive write without a recall index", async () => {
    const { manager, runtime, path, adapter } = await setup();
    vi.spyOn(manager, "archivePreCompactionTurns").mockRejectedValue(new Error("disk gone"));
    const compacted = await runtime.compact(largeTranscript(), 1_000);
    expect(compacted).not.toBeNull();
    expect(JSON.stringify(compacted![0])).not.toContain("recall-index");
    expect(await manager.listCompactionArchives()).toEqual([]);
    expect(adapter.files.has(path)).toBe(true);
  });

  it("deposits the raw summary after the rewrite, tolerating deposit failure", async () => {
    const { adapter, manager, runtime, path } = await setup();
    const seen: string[] = [];
    const runtimeWithHook = new AgentCompactionRuntime({
      getSettings: () => settings(),
      sessionManager: manager,
      summarize: async () => "Summary of earlier turns.",
      onCompacted: async (summary) => {
        seen.push(summary);
      },
    });
    const compacted = await runtimeWithHook.compact(largeTranscript(), 1_000);
    expect(compacted).not.toBeNull();
    expect(seen).toEqual(["Summary of earlier turns."]);
    // Failure afterwards must not fail the compaction.
    const failing = new AgentCompactionRuntime({
      getSettings: () => settings(),
      sessionManager: manager,
      summarize: async () => "Summary of earlier turns.",
      onCompacted: async () => {
        throw new Error("deposit gone");
      },
    });
    await expect(failing.compact(largeTranscript(), 1_000)).resolves.not.toBeNull();
    expect(adapter.files.has(path)).toBe(true);
    void runtime;
  });
});
