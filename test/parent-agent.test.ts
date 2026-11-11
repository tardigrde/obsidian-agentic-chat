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
    // pi 1.0.0 seeds a leading system message from `initialState.systemPrompt`
    // and folds the tool declarations into it, so the transcript is the
    // supplied messages plus that system message.
    expect(agent.state.messages).toEqual([
      {
        role: "system",
        content: "system",
        timestamp: 0,
        toolsAdded: [
          {
            name: "noop",
            description: "No operation.",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      ...messages,
    ]);
    expect(agent.sessionId).toBe("session-1");
    expect(agent.toolExecution).toBe("parallel");
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

describe("guard stop notices (#283)", () => {
  it("keeps turn-cap and loop-guard notices out of the model context", async () => {
    const { buildStopNoticeMessage } = await import("../src/agent/stop-notice");
    const { buildTurnCapNotice } = await import("../src/agent/turn-cap");
    const { harnessNotice: _marker, ...replyShape } = buildStopNoticeMessage("Here is the summary you asked for.");
    const realReply: AgentMessage = {
      ...replyShape,
      usage: { ...replyShape.usage, input: 10, output: 5, totalTokens: 15 },
    };
    // A model reply that happens to start like a notice but has real usage.
    const lookalike: AgentMessage = { ...realReply, content: [{ type: "text", text: "Turn cap: stopped is a setting." }] };
    const turnCapNotice = buildStopNoticeMessage(buildTurnCapNotice(25));
    const loopGuardNotice = buildStopNoticeMessage(
      "Loop guard: stopped after 3 identical read calls with identical results.",
    );
    // A session saved before this fix: same shape, no marker.
    const legacyNotice = { ...buildStopNoticeMessage(buildTurnCapNotice(25)) } as Record<string, unknown>;
    delete legacyNotice.harnessNotice;
    const messages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1 },
      realReply,
      lookalike,
      turnCapNotice,
      loopGuardNotice,
      legacyNotice as unknown as AgentMessage,
      // Marker only: wording that the legacy shape check would not match.
      { ...buildStopNoticeMessage("Harness note with any wording."), usage: realReply.usage } as AgentMessage,
      // Corrupt line: a text block without text must not throw.
      { ...replyShape, content: [{ type: "text" }] } as unknown as AgentMessage,
      { role: "user", content: "continue", timestamp: 2 },
    ];
    const { agent, unsubscribe } = createParentAgent({
      streamFn,
      systemPrompt: "system",
      model: model(),
      thinkingLevel: "low",
      tools: [],
      messages,
      getApiKey: () => "test-key",
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onEvent: () => undefined,
    });

    const sent = await agent.convertToLlm(agent.state.messages);
    const texts = sent.map((m) =>
      typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join(""),
    );
    expect(texts).not.toContain("Harness note with any wording.");
    expect(texts).toEqual([
      "system",
      "hello",
      "Here is the summary you asked for.",
      "Turn cap: stopped is a setting.",
      "",
      "continue",
    ]);
    // The transcript (UI + JSONL) still keeps the notices.
    expect(agent.state.messages).toHaveLength(messages.length + 1);
    unsubscribe();
  });
});
