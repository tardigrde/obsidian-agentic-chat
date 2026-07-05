import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../src/settings";
import { buildSummaryMessage } from "../src/agent/compaction";
import {
  agentCompactionCount,
  agentContextFraction,
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
  it("reports current transcript context fraction from the active model window", () => {
    expect(agentContextFraction({ messages: [assistant(250, 0, "x".repeat(1_000))], model: model({ contextWindow: 1_000 }) })).toBe(0.25);
    expect(agentContextFraction({ messages: [assistant(250)], model: undefined })).toBeUndefined();
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
    });

    expect(estimate?.outputTokens).toBe(123);
    expect(estimate?.usd).toBeGreaterThan(0);
  });

  it("reports image support from the active model input modalities", () => {
    expect(agentSupportsImages(model({ input: ["text", "image"] }))).toBe(true);
    expect(agentSupportsImages(model({ input: ["text"] }))).toBe(false);
    expect(agentSupportsImages(undefined)).toBe(false);
  });
});
