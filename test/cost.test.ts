import { describe, expect, it } from "vitest";
import { estimateRequestCost, hasPricing } from "../src/agent/cost";

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
