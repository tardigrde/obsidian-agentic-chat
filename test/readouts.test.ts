import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import { buildSummaryMessage, estimateContextUsage } from "../src/agent/compaction";
import {
  compactionCount,
  contextFraction,
  estimateNextCostReadout,
} from "../src/agent/readouts";
import { estimateToolDefinitionTokens } from "../src/agent/tool-budget";

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

/** 39 estimated tokens with pi-ai's 3.5 chars-per-token ratio. */
const READ_TOOL = {
  name: "read",
  label: "Read",
  description: "Read a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
} as AgentTool;

describe("agent readouts", () => {
  it("reports context fraction from the current transcript estimate and clamps at 1", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(4_000), timestamp: 2 },
      assistant(1, "y".repeat(4_000)),
    ];

    const estimated = estimateContextUsage(messages);
    // 4,000 chars + 4,000 chars at pi-ai 1.5.0's 3.5 chars/token ratio.
    expect(estimated).toBe(2_286);
    expect(contextFraction(messages, 1_000)).toBe(1);
    expect(contextFraction(messages, estimated * 2)).toBe(0.5);
    expect(contextFraction(messages, 0)).toBeUndefined();
  });

  it("returns undefined when there is no transcript content to estimate", () => {
    expect(contextFraction([], 1_000)).toBeUndefined();
  });

  it("ignores stale provider usage when reporting current context fraction", () => {
    const messages: AgentMessage[] = [assistantWithCache(10, 490)];

    expect(contextFraction(messages, 1_000)).toBe(0.001);
  });

  it("pins the first-turn full load: transcript + system prompt + tool schemas + reserve", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "x".repeat(350), timestamp: 1 }];
    const systemPrompt = "s".repeat(350);
    const contextWindow = 10_000;

    // The old readout counted only the transcript: 100 / 10,000 = 0.01.
    expect(contextFraction(messages, contextWindow)).toBe(0.01);
    // 100 transcript + 100 system prompt + 39 tool schemas + 1,000 reserve.
    expect(
      contextFraction(messages, contextWindow, {
        systemPrompt,
        tools: [READ_TOOL],
        reserveTokens: 1_000,
      }),
    ).toBeCloseTo(0.1239, 10);

    const estimate = estimateNextCostReadout({
      messages,
      model: model({ input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }),
      settings: { ...DEFAULT_SETTINGS, maxTokens: 1_000 },
      systemPrompt,
      tools: [READ_TOOL],
    });
    // Input excludes the reserve; the old first-turn value was 200 (100 + prompt only).
    expect(estimate?.inputTokens).toBe(239);
    expect(estimate?.outputTokens).toBe(1_000);
  });

  it("counts loaded skill bodies because they are part of the composed system prompt", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: 1 }];
    const withoutSkill = contextFraction(messages, 10_000, { systemPrompt: "base prompt" });
    const withSkill = contextFraction(messages, 10_000, {
      systemPrompt: `base prompt\n\n<skill name="writer">${"x".repeat(3_500)}</skill>`,
    });

    expect(withSkill).toBeGreaterThan(withoutSkill!);
  });

  it("counts tool schemas on a later turn, not only the first", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(350), timestamp: 2 },
      assistant(500, "y".repeat(1_750)),
    ];
    const base = {
      messages,
      model: model({ input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }),
      settings: { ...DEFAULT_SETTINGS, maxTokens: 0 },
      systemPrompt: "s".repeat(350),
    };

    const withoutTools = estimateNextCostReadout({ ...base, tools: [] });
    const withTools = estimateNextCostReadout({ ...base, tools: [READ_TOOL] });
    const toolSchemaTokens = estimateToolDefinitionTokens([READ_TOOL]);

    expect(toolSchemaTokens).toBe(39);
    // 600 transcript + 100 system prompt + 39 tool schemas; the prior turn's
    // provider usage no longer hides the tools.
    expect(withoutTools?.inputTokens).toBe(700);
    expect(withTools?.inputTokens).toBe(739);
    expect((withTools?.inputTokens ?? 0) - (withoutTools?.inputTokens ?? 0)).toBe(39);
  });

  it("counts the response reserve as output tokens for the next request", () => {
    const estimate = estimateNextCostReadout({
      messages: [{ role: "user", content: "x".repeat(400), timestamp: 1 }],
      model: model({ input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }),
      settings: { ...DEFAULT_SETTINGS, maxTokens: 123 },
      systemPrompt: "system",
      tools: [],
    });

    expect(estimate?.outputTokens).toBe(123);
    expect(estimate?.usd).toBeGreaterThan(0);
  });

  it("counts automatic compaction summary messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1 },
      buildSummaryMessage("summary one", 2),
      buildSummaryMessage("summary two", 3),
    ];

    expect(compactionCount(messages)).toBe(2);
  });

  it("returns an unknown-marker for models with no cached pricing", () => {
    const result = estimateNextCostReadout({
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      model: model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      settings: DEFAULT_SETTINGS,
      systemPrompt: "system",
      tools: [READ_TOOL],
    });
    expect(result).toBeDefined();
    expect(result?.usd).toBe(0);
    expect(result?.isUnknown).toBe(true);
  });

  it("uses configured maxTokens when estimating next request cost", () => {
    const estimate = estimateNextCostReadout({
      messages: [{ role: "user", content: "x".repeat(400), timestamp: 1 }],
      model: model({ input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }),
      settings: { ...DEFAULT_SETTINGS, maxTokens: 123 },
      systemPrompt: "system",
      tools: [],
    });

    expect(estimate?.outputTokens).toBe(123);
    expect(estimate?.usd).toBeGreaterThan(0);
  });
});
