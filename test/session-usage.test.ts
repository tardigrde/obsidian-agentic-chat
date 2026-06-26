import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSummaryMessage } from "../src/agent/compaction";
import { sumSessionUsage } from "../src/agent/session-usage";
import { emptyUsage } from "../src/agent/usage";

function usage(totalTokens: number, costTotal = 0) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
}

function assistant(totalTokens: number, costTotal = 0): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "openrouter",
    model: "test/model",
    usage: usage(totalTokens, costTotal),
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("sumSessionUsage", () => {
  it("sums assistant turns, compacted dropped turns, and child agent usage", () => {
    const summary = buildSummaryMessage("summary", 1, usage(30, 0.03));
    const total = sumSessionUsage([assistant(10, 0.01), summary, assistant(20, 0.02)], usage(5, 0.005));

    expect(total.totalTokens).toBe(65);
    expect(total.cost.total).toBeCloseTo(0.065, 6);
  });

  it("does not mutate the supplied child usage object", () => {
    const child = usage(7, 0.007);
    const before = JSON.stringify(child);
    const total = sumSessionUsage([assistant(3, 0.003)], child);

    expect(total.totalTokens).toBe(10);
    expect(JSON.stringify(child)).toBe(before);
  });

  it("returns zero usage when the transcript has no usage-bearing messages", () => {
    const total = sumSessionUsage([{ role: "user", content: "hello", timestamp: 1 }], emptyUsage());
    expect(total).toEqual(emptyUsage());
  });
});
