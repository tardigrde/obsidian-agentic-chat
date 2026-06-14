import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentService } from "../src/agent/agent-service";
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

  it("reports a friendly error when no API key is configured", async () => {
    const { service, settings } = makeService(cannedStreamFn("unused"));
    settings.openrouterApiKey = "";
    await service.sendPrompt("Hi");
    expect(service.getError()).toMatch(/API key/);
    expect(service.getMessages()).toHaveLength(0);
  });
});
