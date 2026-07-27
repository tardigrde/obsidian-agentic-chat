import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildModel } from "../src/llm/models";
import { createParentAgent } from "../src/agent/parent-agent";

function streamFn(): ReturnType<StreamFn> {
  return createAssistantMessageEventStream();
}

function model() {
  return buildModel({
    provider: "openrouter",
    modelId: "openai/gpt-4o-mini",
    privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: false },
    ollamaBaseUrl: "http://localhost:11434",
    openaiCompatibleBaseUrl: "http://localhost:3000/api",
  });
}

describe("createParentAgent", () => {
  it("creates a parent agent with the configured runtime state", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: 1 }];
    const tools: AgentTool[] = [
      {
        name: "noop",
        label: "Noop",
        description: "No operation.",
        parameters: { type: "object", properties: {} } as AgentTool["parameters"],
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
      },
    ];

    const { agent, unsubscribe } = createParentAgent({
      streamFn,
      systemPrompt: "system",
      model: model(),
      thinkingLevel: "low",
      tools,
      messages,
      getApiKey: () => "test-key",
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      sessionId: "session-1",
      onEvent: () => undefined,
    });

    expect(agent.state.systemPrompt).toBe("system");
    expect(agent.state.model.id).toBe("openai/gpt-4o-mini");
    expect(agent.state.thinkingLevel).toBe("low");
    expect(agent.state.tools.map((tool) => tool.name)).toEqual(["noop"]);
    expect(agent.state.messages).toEqual(messages);
    expect(agent.sessionId).toBe("session-1");
    expect(agent.toolExecution).toBe("sequential");
    unsubscribe();
  });

  it("subscribes the supplied event handler", async () => {
    const events: AgentEvent[] = [];
    const { agent, unsubscribe } = createParentAgent({
      streamFn,
      systemPrompt: "system",
      model: model(),
      thinkingLevel: "off",
      tools: [],
      messages: [],
      getApiKey: () => "test-key",
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onEvent: (event) => {
        events.push(event);
      },
    });

    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "ok" }],
      api: agent.state.model.api,
      provider: agent.state.model.provider,
      model: agent.state.model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: 2,
    };
    agent.streamFunction = () => {
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    };

    await agent.prompt("hello");

    expect(events.map((event) => event.type)).toContain("agent_end");
    unsubscribe();
  });
});
