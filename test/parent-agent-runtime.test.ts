import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildModel } from "../src/llm/models";
import { ParentAgentRuntime, type ParentAgentRuntimeConfiguration } from "../src/agent/parent-agent-runtime";

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

function configuration(overrides: Partial<ParentAgentRuntimeConfiguration> = {}): ParentAgentRuntimeConfiguration {
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

describe("ParentAgentRuntime", () => {
  it("replaces the current parent agent with configured runtime state", () => {
    const messages = [userMessage("hello")];
    const runtime = new ParentAgentRuntime(() => configuration());

    const agent = runtime.replace(messages);

    expect(agent).toBe(runtime.current);
    expect(agent?.state.systemPrompt).toBe("system");
    expect(agent?.state.model.id).toBe("openai/gpt-4o-mini");
    expect(agent?.state.thinkingLevel).toBe("low");
    expect(agent?.state.tools.map((item) => item.name)).toEqual(["read"]);
    expect(agent?.state.messages).toEqual(messages);
    expect(agent?.sessionId).toBe("session-1");
  });

  it("refreshes the live parent agent configuration in place", () => {
    let current = configuration();
    const runtime = new ParentAgentRuntime(() => current);
    const agent = runtime.replace([]);
    const nextTools = [tool("write")];
    current = configuration({
      systemPrompt: "updated system",
      model: model("anthropic/claude-3.5-sonnet"),
      thinkingLevel: "high",
      tools: nextTools,
    });

    const refreshed = runtime.refreshConfiguration();

    expect(refreshed).toBe(agent);
    expect(agent?.state.systemPrompt).toBe("updated system");
    expect(agent?.state.model.id).toBe("anthropic/claude-3.5-sonnet");
    expect(agent?.state.thinkingLevel).toBe("high");
    expect(agent?.state.tools.map((item) => item.name)).toEqual(["write"]);
  });

  it("detaches and disposes through the lifecycle guard", () => {
    const runtime = new ParentAgentRuntime(() => configuration());

    runtime.replace([]);
    runtime.detach();
    expect(runtime.current).toBeNull();
    expect(() => runtime.requireAgent()).toThrow("Agent is not initialized.");

    runtime.replace([]);
    expect(runtime.dispose()).toBe(true);
    expect(runtime.dispose()).toBe(false);
    expect(runtime.isDisposed).toBe(true);
    expect(runtime.replace([])).toBeNull();
  });
});
