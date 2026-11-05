import { describe, expect, it } from "vitest";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { conversationMessages } from "../src/agent/conversation-messages";
import { ParentAgentRuntime, type ParentAgentRuntimeConfiguration } from "../src/agent/parent-agent-runtime";

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistant(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 2 } as AgentMessage;
}

function system(content: string): AgentMessage {
  return { role: "system", content, timestamp: 0 } as AgentMessage;
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

function configuration(overrides: Partial<ParentAgentRuntimeConfiguration> = {}): ParentAgentRuntimeConfiguration {
  return {
    streamFn: () => createAssistantMessageEventStream(),
    systemPrompt: "system",
    model: {
      id: "openai/gpt-4o-mini",
      name: "GPT-4o mini",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_000,
    } as ParentAgentRuntimeConfiguration["model"],
    thinkingLevel: "low",
    tools: [tool("read")],
    getApiKey: () => "test-key",
    beforeToolCall: async () => undefined,
    afterToolCall: async () => undefined,
    onEvent: () => undefined,
    ...overrides,
  };
}

describe("conversationMessages", () => {
  it("drops the system-context message and keeps the conversation", () => {
    const agent = new Agent({
      streamFn: () => createAssistantMessageEventStream(),
      initialState: { systemPrompt: "you are helpful", messages: [user("hi"), assistant("hello")] },
    });
    expect(agent.state.messages[0]?.role).toBe("system");

    expect(conversationMessages(agent.state.messages).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("preserves message identity so session de-dupe keeps working", () => {
    const first = user("one");
    const second = assistant("two");
    const conversation = conversationMessages([system("prompt"), first, second]);

    expect(conversation[0]).toBe(first);
    expect(conversation[1]).toBe(second);
  });

  it("is a no-op when the transcript carries no system message", () => {
    const messages = [user("hi"), assistant("hello")];
    expect(conversationMessages(messages)).toEqual(messages);
  });
});

describe("ParentAgentRuntime system-prompt handling", () => {
  it("keeps the freshly composed prompt when rehydrating a session that persisted one", () => {
    // A session file written by an older build, or hand-edited, can carry a
    // system message. Replaying it verbatim would pin that stale prompt.
    const runtime = new ParentAgentRuntime(() => configuration({ systemPrompt: "fresh prompt" }));

    const agent = runtime.replace([system("stale prompt"), user("hi")]);

    expect(agent?.state.systemPrompt).toBe("fresh prompt");
    expect(agent?.state.messages[0]).toMatchObject({ role: "system", content: "fresh prompt" });
    expect(agent?.state.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(agent?.state.messages.some((message) => JSON.stringify(message).includes("stale prompt"))).toBe(false);
  });

  it("replaces the prompt on refresh instead of accumulating fragments", () => {
    let current = configuration({ systemPrompt: "first prompt" });
    const runtime = new ParentAgentRuntime(() => current);
    const agent = runtime.replace([]);
    expect(agent?.state.systemPrompt).toBe("first prompt");

    current = configuration({ systemPrompt: "second prompt" });
    runtime.refreshConfiguration();
    expect(agent?.state.systemPrompt).toBe("second prompt");

    current = configuration({ systemPrompt: "third prompt" });
    runtime.refreshConfiguration();
    expect(agent?.state.systemPrompt).toBe("third prompt");
    // Replacement, not accumulation: still exactly one system message.
    expect(agent?.state.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(JSON.stringify(agent?.state.messages)).not.toContain("second prompt");
  });

  it("keeps the tool declarations when refreshing the prompt", () => {
    // Wiping toolsAdded would make pi re-announce the whole tool set every turn.
    const runtime = new ParentAgentRuntime(() => configuration({ systemPrompt: "updated" }));
    const agent = runtime.replace([user("hi")]);

    runtime.refreshConfiguration();

    expect((agent?.state.messages[0] as { toolsAdded?: unknown[] }).toolsAdded).toHaveLength(1);
  });

});
