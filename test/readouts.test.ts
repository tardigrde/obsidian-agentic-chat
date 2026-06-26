import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../src/settings";
import { buildSummaryMessage } from "../src/agent/compaction";
import { compactionCount, contextFraction, estimateNextCostReadout } from "../src/agent/readouts";

function assistant(inputTokens: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
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
  it("reports context fraction from the latest assistant input usage and clamps at 1", () => {
    const messages: AgentMessage[] = [
      assistant(200),
      { role: "user", content: "next", timestamp: 2 },
      assistant(1_500),
    ];

    expect(contextFraction(messages, 1_000)).toBe(1);
    expect(contextFraction(messages, 2_000)).toBe(0.75);
    expect(contextFraction(messages, 0)).toBeUndefined();
  });

  it("ignores assistant turns without input usage when reporting context fraction", () => {
    const messages = [
      assistant(400),
      { ...assistant(0), usage: undefined },
    ] as AgentMessage[];

    expect(contextFraction(messages, 1_000)).toBe(0.4);
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
