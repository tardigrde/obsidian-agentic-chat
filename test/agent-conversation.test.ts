import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildModel } from "../src/llm/models";
import { AgentConversation, type ParentAgentConfiguration } from "../src/agent/conversation";
import type { ParentAgentHandle } from "../src/agent/parent-agent";
import { ObsidianSessionManager, type SessionDefaults } from "../src/session/session-manager";
import { MemoryAdapter } from "./helpers/memory-adapter";

const DEFAULTS: SessionDefaults = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" };

function streamFn(): ReturnType<StreamFn> {
  return createAssistantMessageEventStream();
}

function model(modelId = "openai/gpt-4o-mini") {
  return buildModel({
    provider: "openrouter",
    modelId,
    privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: false },
    ollamaBaseUrl: "http://localhost:11434",
    openaiCompatibleBaseUrl: "http://localhost:3000/api",
  });
}

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} } as AgentTool["parameters"],
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
  };
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function systemMessage(content: string): AgentMessage {
  return { role: "system", content, timestamp: 0 } as AgentMessage;
}

function messageText(message: AgentMessage): string {
  return (message as unknown as { content: [{ text: string }] }).content[0].text;
}

function configuration(overrides: Partial<ParentAgentConfiguration> = {}): ParentAgentConfiguration {
  return {
    streamFn,
    systemPrompt: "system",
    model: model(),
    thinkingLevel: "low",
    tools: [tool("read")],
    getApiKey: () => "test-key",
    beforeToolCall: async () => undefined,
    afterToolCall: async () => undefined,
    sessionId: "session-1",
    onEvent: () => undefined,
    ...overrides,
  };
}

function makeConversation(
  options: {
    buildConfiguration?: () => ParentAgentConfiguration;
    getDefaults?: () => SessionDefaults;
    createAgent?: () => ParentAgentHandle;
    failReload?: boolean;
  } = {},
) {
  const events: string[] = [];
  const adapter = new MemoryAdapter();
  const manager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  const conversation = new AgentConversation({
    sessionManager: manager,
    getDefaults: options.getDefaults ?? (() => DEFAULTS),
    buildConfiguration: () => {
      events.push("build-config");
      return (options.buildConfiguration ?? (() => configuration()))();
    },
    createAgent: options.createAgent,
    sessionEvents: { markPersistedMessages: (messages) => events.push(`persist:${messages.length}`) },
    sessionState: { reset: () => events.push("state:reset") },
    toolCalls: { clearSessionState: () => events.push("tools:clear") },
    runtimeResources: {
      clearSessionState: () => events.push("resources:clear"),
      reload: async () => {
        events.push("resources:reload");
        if (options.failReload) throw new Error("resource reload failed");
      },
    },
  });
  return { conversation, manager, events };
}

function fakeHandle(): { handle: ParentAgentHandle; abort: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> } {
  const abort = vi.fn();
  const unsubscribe = vi.fn();
  return { handle: { agent: { abort, state: { messages: [] } } as unknown as Agent, unsubscribe }, abort, unsubscribe };
}

describe("AgentConversation: parent agent", () => {
  it("installs a transcript on an agent built from the current configuration", () => {
    const { conversation, events } = makeConversation();
    const messages = [userMessage("hello")];

    const agent = conversation.installTranscript(messages);

    expect(events).toEqual(["persist:1", "build-config"]);
    expect(agent).toBe(conversation.currentAgent);
    expect(agent?.state.systemPrompt).toBe("system");
    expect(agent?.state.model.id).toBe("openai/gpt-4o-mini");
    expect(agent?.state.thinkingLevel).toBe("low");
    expect(agent?.state.tools.map((item) => item.name)).toEqual(["read"]);
    // pi 1.0.0 seeds a leading system message carrying the prompt and the tool
    // declarations, ahead of the supplied conversation messages.
    expect(agent?.state.messages).toEqual([
      {
        role: "system",
        content: "system",
        timestamp: 0,
        toolsAdded: [{ name: "read", description: "read tool", parameters: { type: "object", properties: {} } }],
      },
      ...messages,
    ]);
    expect(agent?.sessionId).toBe("session-1");
  });

  it("keeps the freshly composed prompt when rehydrating a session that persisted one", () => {
    // A session file written by an older build, or hand-edited, can carry a
    // system message. Replaying it verbatim would pin that stale prompt.
    const { conversation } = makeConversation({ buildConfiguration: () => configuration({ systemPrompt: "fresh prompt" }) });

    const agent = conversation.installTranscript([systemMessage("stale prompt"), userMessage("hi")]);

    expect(agent?.state.systemPrompt).toBe("fresh prompt");
    expect(agent?.state.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(agent?.state.messages.some((message) => JSON.stringify(message).includes("stale prompt"))).toBe(false);
  });

  it("applies a new configuration to the live agent in place", () => {
    let current = configuration();
    const { conversation } = makeConversation({ buildConfiguration: () => current });
    const agent = conversation.installTranscript([userMessage("hi")]);
    current = configuration({
      systemPrompt: "updated system",
      model: model("anthropic/claude-3.5-sonnet"),
      thinkingLevel: "high",
      tools: [tool("write")],
    });

    expect(conversation.applyConfiguration()).toBe(agent);

    expect(agent?.state.systemPrompt).toBe("updated system");
    expect(agent?.state.model.id).toBe("anthropic/claude-3.5-sonnet");
    expect(agent?.state.thinkingLevel).toBe("high");
    expect(agent?.state.tools.map((item) => item.name)).toEqual(["write"]);
    // Rewritten, not appended: still exactly one system message, and its tool
    // declarations survive so pi does not re-announce the tool set every turn.
    expect(agent?.state.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect((agent?.state.messages[0] as { toolsAdded?: unknown[] }).toolsAdded).toHaveLength(1);
  });

  it("replaces the prompt on every refresh instead of accumulating fragments", () => {
    let current = configuration({ systemPrompt: "first prompt" });
    const { conversation } = makeConversation({ buildConfiguration: () => current });
    const agent = conversation.installTranscript([]);

    current = configuration({ systemPrompt: "second prompt" });
    conversation.applyConfiguration();
    current = configuration({ systemPrompt: "third prompt" });
    conversation.applyConfiguration();

    expect(agent?.state.systemPrompt).toBe("third prompt");
    expect(JSON.stringify(agent?.state.messages)).not.toContain("second prompt");
  });

  it("reloads resources, applies the configuration, then records it in the session", async () => {
    let defaults = DEFAULTS;
    const { conversation, manager, events } = makeConversation({ getDefaults: () => defaults });
    await conversation.create();
    conversation.installTranscript([]);
    events.length = 0;
    defaults = { provider: "openrouter", modelId: "changed/model", thinkingLevel: "high" };

    await conversation.refreshConfiguration();

    expect(events).toEqual(["resources:reload", "build-config"]);
    expect(manager.buildSessionContext().model).toEqual({ provider: "openrouter", modelId: "changed/model" });
    expect(conversation.info?.path).toBe(conversation.activePath);
  });

  it("refuses to refresh without a live agent", async () => {
    const { conversation, events } = makeConversation();

    await expect(conversation.refreshConfiguration()).rejects.toThrow("Agent is not initialized.");
    expect(events).toEqual([]);
  });

  it("unsubscribes a replaced agent without aborting it", () => {
    const first = fakeHandle();
    const second = fakeHandle();
    const handles = [first.handle, second.handle];
    const { conversation } = makeConversation({ createAgent: () => handles.shift() as ParentAgentHandle });

    conversation.installTranscript([]);
    conversation.installTranscript([]);

    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(first.abort).not.toHaveBeenCalled();
    expect(second.unsubscribe).not.toHaveBeenCalled();
    expect(conversation.currentAgent).toBe(second.handle.agent);
  });

  it("detaches by unsubscribing, aborting, and clearing the agent", () => {
    const fake = fakeHandle();
    const { conversation } = makeConversation({ createAgent: () => fake.handle });

    conversation.installTranscript([]);
    conversation.detachAgent();

    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fake.abort).toHaveBeenCalledTimes(1);
    expect(conversation.currentAgent).toBeNull();
    expect(() => conversation.requireAgent()).toThrow("Agent is not initialized.");
  });

  it("disposes once and never creates another agent", () => {
    const fake = fakeHandle();
    const createAgent = vi.fn(() => fake.handle);
    const { conversation } = makeConversation({ createAgent });

    conversation.installTranscript([]);
    expect(conversation.dispose()).toBe(true);
    expect(conversation.dispose()).toBe(false);

    expect(fake.abort).toHaveBeenCalledTimes(1);
    expect(conversation.isDisposed).toBe(true);
    expect(conversation.installTranscript([])).toBeNull();
    expect(createAgent).toHaveBeenCalledTimes(1);
  });
});

describe("AgentConversation: activation", () => {
  it("reloads resources before resetting session state and replacing the agent", async () => {
    const { conversation, events } = makeConversation();

    await conversation.activate([userMessage("loaded")]);

    expect(events).toEqual([
      "resources:reload",
      "persist:1",
      "state:reset",
      "tools:clear",
      "resources:clear",
      "build-config",
    ]);
    expect(conversation.currentAgent?.state.messages.slice(1)).toEqual([userMessage("loaded")]);
  });

  it("keeps the live agent and session state when the resource reload fails", async () => {
    const { conversation, events } = makeConversation({ failReload: true });
    const active = conversation.installTranscript([userMessage("active")]);
    events.length = 0;

    await expect(conversation.activate([userMessage("loaded")])).rejects.toThrow("resource reload failed");

    expect(events).toEqual(["resources:reload"]);
    expect(conversation.currentAgent).toBe(active);
  });

  it("can activate a rewritten transcript without reloading resources", async () => {
    const { conversation, events } = makeConversation();

    await conversation.activate([userMessage("rewound")], { reloadResources: false });

    expect(events).toEqual(["persist:1", "state:reset", "tools:clear", "resources:clear", "build-config"]);
  });
});

describe("AgentConversation: session file", () => {
  it("continues by creating a session when no recent session exists", async () => {
    const { conversation } = makeConversation();

    const snapshot = await conversation.continueRecent();

    expect(snapshot.info.path).toMatch(/sessions\/.*\.jsonl/);
    expect(snapshot.messages).toEqual([]);
    expect(conversation.info).toBe(snapshot.info);
    expect(conversation.activePath).toBe(snapshot.info.path);
  });

  it("loads a session snapshot with reconstructed messages", async () => {
    const { conversation, manager } = makeConversation();
    const first = await conversation.create();
    await manager.appendMessage(userMessage("first"));
    await conversation.create();

    const loaded = await conversation.load(first.info.path);

    expect(loaded.info.path).toBe(first.info.path);
    expect(loaded.messages.map(messageText)).toEqual(["first"]);
    expect(conversation.info?.path).toBe(first.info.path);
  });

  it("rewrites messages and refreshes the cached session info", async () => {
    const { conversation, manager } = makeConversation();
    await conversation.create();
    await manager.appendMessage(userMessage("first"));
    await manager.appendMessage(userMessage("second"));

    const snapshot = await conversation.rewriteMessages([userMessage("first")]);

    expect(snapshot.messages.map(messageText)).toEqual(["first"]);
    expect(snapshot.info.messageCount).toBe(1);
    expect(conversation.info?.messageCount).toBe(1);
  });

  it("clears cached info when deleting the active session", async () => {
    const { conversation } = makeConversation();
    const snapshot = await conversation.create();

    await conversation.delete(snapshot.info.path);

    expect(conversation.info).toBeUndefined();
    expect(conversation.activePath).toBeNull();
  });
});
