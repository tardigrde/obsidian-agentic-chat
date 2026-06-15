import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateNextRequestCost, estimateRequestCost, hasPricing } from "../src/agent/cost";

const PRICED = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 };
const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("estimateRequestCost", () => {
  it("computes USD from per-million pricing", () => {
    const estimate = estimateRequestCost({ inputTokens: 1_000_000, outputTokens: 500_000, cost: PRICED });
    expect(estimate.usd).toBeCloseTo(3 + 7.5, 6); // 1M × $3 input + 0.5M × $15 output
    expect(estimate.inputTokens).toBe(1_000_000);
    expect(estimate.outputTokens).toBe(500_000);
  });

  it("is zero without pricing", () => {
    expect(estimateRequestCost({ inputTokens: 2_000_000, outputTokens: 2_000_000, cost: undefined }).usd).toBe(0);
    expect(estimateRequestCost({ inputTokens: 2_000_000, outputTokens: 2_000_000, cost: FREE }).usd).toBe(0);
  });
});

describe("hasPricing", () => {
  it("distinguishes priced from free/unknown models", () => {
    expect(hasPricing(PRICED)).toBe(true);
    expect(hasPricing({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 })).toBe(true);
    expect(hasPricing(FREE)).toBe(false);
    expect(hasPricing(undefined)).toBe(false);
  });
});

describe("estimateNextRequestCost", () => {
  it("derives input tokens from the transcript size", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "x".repeat(4000) }], timestamp: 0 } as AgentMessage,
    ];
    const estimate = estimateNextRequestCost(messages, PRICED, 0);
    expect(estimate.inputTokens).toBeGreaterThan(0);
    expect(estimate.usd).toBeGreaterThan(0);
  });

  it("folds in the system prompt only when there's no prior provider usage", () => {
    const userMsg = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } as AgentMessage;
    const systemPrompt = "s".repeat(4000); // ≈ 1000 tokens

    // No prior usage → fall back to the heuristic, which should include the prompt.
    const withSys = estimateNextRequestCost([userMsg], PRICED, 0, systemPrompt);
    const withoutSys = estimateNextRequestCost([userMsg], PRICED, 0);
    expect(withSys.inputTokens).toBe(withoutSys.inputTokens + 1000);

    // Prior assistant usage already counts the system prompt; don't double-count.
    const assistantMsg = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: { input: 500, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 510, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: 0,
    } as unknown as AgentMessage;
    const withUsage = estimateNextRequestCost([userMsg, assistantMsg], PRICED, 0, systemPrompt);
    const withUsageNoSys = estimateNextRequestCost([userMsg, assistantMsg], PRICED, 0);
    expect(withUsage.inputTokens).toBe(withUsageNoSys.inputTokens);
  });
});
