import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentService } from "../src/agent/agent-service";
import { isSummaryMessage } from "../src/agent/compaction";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { parseSessionEntries } from "../src/session/jsonl";
import { MemoryAdapter } from "./helpers/memory-adapter";

/** Stream function that returns a fixed assistant reply without any network. */
function cannedStreamFn(text: string): StreamFn {
  return ((model: Model<"openai-completions">) => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 5,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
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
}

/** Stream function that scripts one assistant message per agent turn. */
function scriptedStreamFn(
  turns: Array<{ content: AssistantMessage["content"]; stopReason: "stop" | "toolUse" }>,
): StreamFn {
  let turn = 0;
  return ((model: Model<"openai-completions">) => {
    const stream = createAssistantMessageEventStream();
    const spec = turns[Math.min(turn, turns.length - 1)];
    turn += 1;
    const message = {
      role: "assistant" as const,
      content: spec.content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: spec.stopReason,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: spec.stopReason, message });
      stream.end(message);
    });
    return stream;
  }) as unknown as StreamFn;
}

/** Scripts one assistant message per turn, each carrying a USD cost. */
function scriptedCostStreamFn(
  turns: Array<{ content: AssistantMessage["content"]; stopReason: "stop" | "toolUse"; costTotal: number }>,
): StreamFn {
  let turn = 0;
  return ((model: Model<"openai-completions">) => {
    const stream = createAssistantMessageEventStream();
    const spec = turns[Math.min(turn, turns.length - 1)];
    turn += 1;
    const message = {
      role: "assistant" as const,
      content: spec.content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: spec.costTotal },
      },
      stopReason: spec.stopReason,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: spec.stopReason, message });
      stream.end(message);
    });
    return stream;
  }) as unknown as StreamFn;
}

function makeService(
  streamFn: StreamFn,
  confirmToolCall: () => Promise<boolean> = async () => true,
): { service: AgentService; adapter: MemoryAdapter; settings: AgenticChatSettings } {
  const settings: AgenticChatSettings = { ...DEFAULT_SETTINGS, openrouterApiKey: "test-key" };
  const adapter = new MemoryAdapter();
  const sessionManager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  const service = new AgentService({
    app: { vault: {}, workspace: {} } as unknown as App,
    getSettings: () => settings,
    sessionManager,
    confirmToolCall,
    streamFn,
  });
  return { service, adapter, settings };
}

describe("AgentService", () => {
  it("runs a prompt, exposes the transcript, and tracks usage", async () => {
    const { service } = makeService(cannedStreamFn("Hello from the agent."));
    await service.sendPrompt("Say hello");

    const roles = service.getMessages().map((message) => message.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(service.getSessionUsage().totalTokens).toBe(12);
    expect(service.getError()).toBeUndefined();
    expect(service.isStreaming()).toBe(false);
  });

  it("persists the conversation to a JSONL session file", async () => {
    const { service, adapter } = makeService(cannedStreamFn("Persisted reply."));
    await service.sendPrompt("Remember this");

    const sessionFile = [...adapter.files.keys()].find((path) => path.endsWith(".jsonl"));
    expect(sessionFile).toBeDefined();
    const entries = parseSessionEntries(adapter.files.get(sessionFile as string) as string);
    const messageEntries = entries.filter((entry) => entry.type === "message");
    expect(messageEntries).toHaveLength(2);
  });

  it("sends a denial result back to the model when the user declines a tool call", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "note.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Understood, I won't write it." }], stopReason: "stop" },
    ]);
    const { service } = makeService(streamFn, async () => false);
    await service.sendPrompt("Create note.md");

    const messages = service.getMessages();
    const toolResult = messages.find((message) => message.role === "toolResult") as
      | { role: "toolResult"; isError: boolean; content: Array<{ type: string; text?: string }> }
      | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult?.isError).toBe(true);
    const resultText = (toolResult?.content ?? []).map((block) => block.text ?? "").join("");
    expect(resultText).toMatch(/declined/i);
    // The model received the denial and produced a follow-up turn.
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("blocks mutating tools in ask mode and feeds the read-only denial back to the model", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "note.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Read-only — here's what I would write." }], stopReason: "stop" },
    ]);
    // Approval allows mutating and the user would confirm — ask mode must still block.
    const { service, settings } = makeService(streamFn, async () => true);
    settings.mode = "ask";
    settings.approval = { mutating: "allow", perTool: {} };
    await service.sendPrompt("Create note.md");

    const toolResult = service.getMessages().find((message) => message.role === "toolResult") as
      | { role: "toolResult"; isError: boolean; content: Array<{ type: string; text?: string }> }
      | undefined;
    expect(toolResult?.isError).toBe(true);
    const resultText = (toolResult?.content ?? []).map((block) => block.text ?? "").join("");
    expect(resultText).toMatch(/read-only/i);
  });

  it("dispatches a subagent, folds child usage into the session, and exposes profiles", async () => {
    const streamFn = scriptedStreamFn([
      // Parent turn 1: ask to dispatch the researcher subagent.
      { content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { agent: "researcher", task: "summarize the inbox" } }], stopReason: "toolUse" },
      // Child turn: the researcher's reply (same injected stream serves the child).
      { content: [{ type: "text", text: "Inbox has 3 open threads." }], stopReason: "stop" },
      // Parent turn 2: final answer after the subagent returns.
      { content: [{ type: "text", text: "All done." }], stopReason: "stop" },
    ]);
    const { service } = makeService(streamFn);
    await service.sendPrompt("Use a subagent to check my inbox");

    expect(service.getProfiles().map((profile) => profile.name)).toContain("researcher");
    const toolResult = service.getMessages().find((message) => message.role === "toolResult") as
      | { role: "toolResult"; isError: boolean; content: Array<{ type: string; text?: string }> }
      | undefined;
    expect(toolResult?.isError).toBe(false);
    const resultText = (toolResult?.content ?? []).map((block) => block.text ?? "").join("");
    expect(resultText).toContain("Inbox has 3 open threads.");
    // Parent's two assistant turns (2 + 2) plus the child's folded-in usage (2).
    expect(service.getSessionUsage().totalTokens).toBe(6);
  });

  it("auto-compacts old turns once the context window fills, preserving usage", async () => {
    // Each assistant turn reports ~110k context tokens — over 80% of the synthesized
    // 128k window — so the third send triggers compaction of the first turn.
    const bigUsageStream: StreamFn = ((model: Model<"openai-completions">) => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "ok" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 110_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 110_100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
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

    const settings: AgenticChatSettings = {
      ...DEFAULT_SETTINGS,
      openrouterApiKey: "test-key",
      // An id absent from pi's catalog → synthesized model with the default 128k window.
      openrouterModel: "test/compaction-model",
    };
    const adapter = new MemoryAdapter();
    const sessionManager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    let summarizeCalls = 0;
    const service = new AgentService({
      app: { vault: {}, workspace: {} } as unknown as App,
      getSettings: () => settings,
      sessionManager,
      confirmToolCall: async () => true,
      streamFn: bigUsageStream,
      summarize: async () => {
        summarizeCalls += 1;
        return "Summary of earlier turns.";
      },
    });

    await service.sendPrompt("first");
    await service.sendPrompt("second");
    expect(service.getCompactionCount()).toBe(0); // only one user turn behind us so far

    await service.sendPrompt("third"); // maybeCompact runs before this prompt
    expect(summarizeCalls).toBe(1);
    expect(service.getCompactionCount()).toBe(1);

    const messages = service.getMessages();
    expect(isSummaryMessage(messages[0])).toBe(true);
    // The first turn was folded into the summary, not left verbatim.
    expect(messages.some((m) => JSON.stringify(m).includes('"first"'))).toBe(false);
    // 3 turns × 110_100 totalTokens, with the dropped turn folded into the session total.
    expect(service.getSessionUsage().totalTokens).toBe(330_300);

    // The compacted usage is carried on the summary message, so reloading the
    // session from disk into a fresh service preserves the total and the count.
    const path = service.getSessionInfo()?.path as string;
    const reloaded = new AgentService({
      app: { vault: {}, workspace: {} } as unknown as App,
      getSettings: () => settings,
      sessionManager: new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test"),
      confirmToolCall: async () => true,
      streamFn: bigUsageStream,
      summarize: async () => "unused",
    });
    await reloaded.loadSession(path);
    expect(reloaded.getCompactionCount()).toBe(1);
    expect(reloaded.getSessionUsage().totalTokens).toBe(330_300);
  });

  it("blocks new turns once the hard spend cap is reached", async () => {
    const costStream: StreamFn = ((model: Model<"openai-completions">) => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "ok" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
        },
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

    const { service, settings } = makeService(costStream);
    settings.notifications.costCapUsd = 0.01;

    await service.sendPrompt("one"); // allowed: cost is 0 at send time
    expect(service.getSessionUsage().cost?.total).toBeCloseTo(0.02, 6);

    await service.sendPrompt("two"); // blocked: 0.02 already ≥ 0.01 cap
    expect(service.getError()).toMatch(/spend cap/i);
    // The blocked prompt never ran, so only the first turn's two messages exist.
    expect(service.getMessages().map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("aborts an in-flight turn once the running turn crosses the spend cap", async () => {
    // Turn 1 is a tool call that already costs 0.02 (> the 0.01 cap); the loop
    // must abort after that turn instead of proceeding to a second turn.
    const stream = scriptedCostStreamFn([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "n.md", content: "x" } }], stopReason: "toolUse", costTotal: 0.02 },
      { content: [{ type: "text", text: "should not run" }], stopReason: "stop", costTotal: 0.02 },
    ]);
    const { service, settings } = makeService(stream, async () => true);
    settings.notifications.costCapUsd = 0.01;

    await service.sendPrompt("go"); // cost is 0 at send time, so the turn starts
    // The "stopped this turn" wording is only produced by the in-flight
    // enforceSpendCap path (the pre-send block uses different wording), so this
    // proves the cap fired mid-run and aborted the agent.
    expect(service.getError()).toMatch(/stopped this turn/i);
  });

  it("reports a friendly error when no API key is configured", async () => {
    const { service, settings } = makeService(cannedStreamFn("unused"));
    settings.openrouterApiKey = "";
    await service.sendPrompt("Hi");
    expect(service.getError()).toMatch(/API key/);
    expect(service.getMessages()).toHaveLength(0);
  });
});
