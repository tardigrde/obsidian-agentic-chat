import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { Model } from "@earendil-works/pi-ai";
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

function makeService(streamFn: StreamFn): { service: AgentService; adapter: MemoryAdapter; settings: AgenticChatSettings } {
  const settings: AgenticChatSettings = { ...DEFAULT_SETTINGS, openrouterApiKey: "test-key" };
  const adapter = new MemoryAdapter();
  const sessionManager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  const service = new AgentService({
    app: {} as App,
    getSettings: () => settings,
    sessionManager,
    confirmToolCall: async () => true,
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

  it("reports a friendly error when no API key is configured", async () => {
    const { service, settings } = makeService(cannedStreamFn("unused"));
    settings.openrouterApiKey = "";
    await service.sendPrompt("Hi");
    expect(service.getError()).toMatch(/API key/);
    expect(service.getMessages()).toHaveLength(0);
  });
});
