import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../src/settings";
import { buildSummaryMessage } from "../src/agent/compaction";
import { compactionCount, contextFraction, estimateNextCostReadout } from "../src/agent/readouts";

function assistant(inputTokens: number, text = "ok"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: "test/model",
    usage: {
      input: inputTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function assistantWithCache(inputTokens: number, cacheRead: number, cacheWrite = 0): AgentMessage {
  const message = assistant(inputTokens) as Extract<AgentMessage, { role: "assistant" }>;
  message.usage = {
    ...message.usage,
    input: inputTokens,
    cacheRead,
    cacheWrite,
    totalTokens: inputTokens + cacheRead + cacheWrite,
  };
  return message;
}

function model(cost: Model<Api>["cost"]): Model<Api> {
  return {
    id: "test/model",
    name: "test/model",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost,
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
}

describe("agent readouts", () => {
  it("reports context fraction from the current transcript estimate and clamps at 1", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(4_000), timestamp: 2 },
      assistant(1, "y".repeat(4_000)),
    ];

    expect(contextFraction(messages, 1_000)).toBe(1);
    expect(contextFraction(messages, 4_000)).toBe(0.5);
    expect(contextFraction(messages, 0)).toBeUndefined();
  });

  it("returns undefined when there is no transcript content to estimate", () => {
    expect(contextFraction([], 1_000)).toBeUndefined();
  });

  it("ignores stale provider usage when reporting current context fraction", () => {
    const messages: AgentMessage[] = [assistantWithCache(10, 490)];

    expect(contextFraction(messages, 1_000)).toBe(0.001);
  });

  it("counts automatic compaction summary messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1 },
      buildSummaryMessage("summary one", 2),
      buildSummaryMessage("summary two", 3),
    ];

    expect(compactionCount(messages)).toBe(2);
  });

  it("returns undefined for unpriced next-cost estimates", () => {
    expect(
      estimateNextCostReadout({
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        model: model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
        settings: DEFAULT_SETTINGS,
        systemPrompt: "system",
      }),
    ).toBeUndefined();
  });

  it("uses configured maxTokens when estimating next request cost", () => {
    const estimate = estimateNextCostReadout({
      messages: [{ role: "user", content: "x".repeat(400), timestamp: 1 }],
      model: model({ input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }),
      settings: { ...DEFAULT_SETTINGS, maxTokens: 123 },
      systemPrompt: "system",
    });

    expect(estimate?.outputTokens).toBe(123);
    expect(estimate?.usd).toBeGreaterThan(0);
  });
});
