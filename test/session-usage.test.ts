import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSummaryMessage } from "../src/agent/compaction";
import { sumSessionUsage } from "../src/agent/session-usage";
import { emptyUsage } from "../src/agent/usage";
import { buildSessionContext, createSessionHeader, type SessionEntry } from "../src/session/jsonl";

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

  it("does not count the messages a compaction replaced", () => {
    const entries: SessionEntry[] = [
      createSessionHeader("sid", "vault"),
      { type: "message", id: "m1", parentId: null, timestamp: "t", message: assistant(100, 0.1) },
      { type: "message", id: "m2", parentId: "m1", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "two" }], timestamp: 1 } as AgentMessage },
      { type: "message", id: "m3", parentId: "m2", timestamp: "t", message: assistant(20, 0.02) },
      {
        type: "compaction",
        id: "c1",
        parentId: "m3",
        timestamp: "t",
        summary: buildSummaryMessage("summary", 1, usage(30, 0.03)),
        firstKeptEntryId: "m2",
      },
      { type: "message", id: "m4", parentId: "c1", timestamp: "t", message: assistant(5, 0.005) },
    ];

    // The summary carries the dropped turn's 30 tokens; the kept 20 and later
    // 5 count once. The replaced 100 must not be added again from the file.
    expect(sumSessionUsage(buildSessionContext(entries).messages).totalTokens).toBe(55);
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
