import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../src/settings";
import { buildSummaryMessage, estimateContextUsage } from "../src/agent/compaction";
import {
  agentCompactionCount,
  agentContextFraction,
  agentContextReadout,
  agentNextCostEstimate,
  agentSessionUsage,
  agentSupportsImages,
} from "../src/agent/service-readouts";

function assistant(inputTokens: number, totalCost = 0, text = "ok"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: "test/model",
    usage: {
      input: inputTokens,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function usage(totalTokens: number): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test/model",
    name: "test/model",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 1_000,
    ...overrides,
  };
}

describe("agent service readouts", () => {
  it("reports the full context load from the active model window", () => {
    const message = assistant(250, 0, "x".repeat(1_000));
    const estimated = estimateContextUsage([message]);
    expect(estimated).toBe(286);
    const readout = agentContextReadout({
      messages: [message],
      model: model({ contextWindow: estimated + 1_000 }),
      settings: DEFAULT_SETTINGS,
      systemPrompt: "",
      tools: [],
    });
    expect(readout?.load).toEqual({
      transcriptTokens: 286,
      systemPromptTokens: 0,
      toolSchemaTokens: 0,
      reserveTokens: 1_000,
      inputTokens: 286,
      totalTokens: 1_286,
    });
    expect(readout?.fraction).toBe(1);
    expect(
      agentContextFraction({
        messages: [message],
        model: model({ contextWindow: (estimated + 1_000) * 2 }),
        settings: DEFAULT_SETTINGS,
        systemPrompt: "",
        tools: [],
      }),
    ).toBe(0.5);
    expect(
      agentContextFraction({
        messages: [message],
        model: undefined,
        settings: DEFAULT_SETTINGS,
        systemPrompt: "",
        tools: [],
      }),
    ).toBeUndefined();
  });

  it("passes the system prompt and active tool schemas into the context load", () => {
    const message = assistant(250, 0, "x".repeat(1_000));
    const tool = {
      name: "read",
      label: "Read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    } as AgentTool;
    const readout = agentContextReadout({
      messages: [message],
      model: model({ contextWindow: 10_000 }),
      settings: DEFAULT_SETTINGS,
      systemPrompt: "s".repeat(350),
      tools: [tool],
    });

    expect(readout?.load).toMatchObject({
      transcriptTokens: 286,
      systemPromptTokens: 100,
      toolSchemaTokens: 34,
      reserveTokens: 1_000,
      inputTokens: 420,
      totalTokens: 1_420,
    });
  });

  it("sums visible transcript and subagent usage", () => {
    const total = agentSessionUsage({
      messages: [assistant(10)],
      subagentUsage: usage(5),
    });

    expect(total.totalTokens).toBe(16);
  });

  it("counts compaction summaries in the active transcript", () => {
    expect(agentCompactionCount({ messages: [buildSummaryMessage("summary", 1), assistant(2)] })).toBe(1);
  });

  it("estimates next cost with the configured output token budget and system prompt", () => {
    const estimate = agentNextCostEstimate({
      messages: [{ role: "user", content: "x".repeat(400), timestamp: 1 }],
      model: model(),
      settings: { ...DEFAULT_SETTINGS, maxTokens: 123 },
      systemPrompt: "system",
      tools: [],
    });

    // 115 transcript tokens + 2 system-prompt tokens; the output budget is separate.
    expect(estimate?.inputTokens).toBe(117);
    expect(estimate?.outputTokens).toBe(123);
    expect(estimate?.usd).toBeGreaterThan(0);
  });

  it("reports image support from the active model input modalities", () => {
    expect(agentSupportsImages(model({ input: ["text", "image"] }))).toBe(true);
    expect(agentSupportsImages(model({ input: ["text"] }))).toBe(false);
    expect(agentSupportsImages(undefined)).toBe(false);
  });
});
