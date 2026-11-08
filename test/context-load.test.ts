import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { DEFAULT_SETTINGS } from "../src/settings";
import {
  contextReadout,
  estimateContextLoad,
  expectedOutputTokens,
} from "../src/agent/readouts";

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

describe("context load estimate", () => {
  it("returns the full section breakdown for the next request", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "x".repeat(350), timestamp: 1 }];
    const load = estimateContextLoad({
      messages,
      systemPrompt: "s".repeat(350),
      tools: [READ_TOOL],
      reserveTokens: 1_000,
    });

    expect(load).toEqual({
      transcriptTokens: 100,
      systemPromptTokens: 100,
      toolSchemaTokens: 34,
      reserveTokens: 1_000,
      inputTokens: 234,
      totalTokens: 1_234,
    });
  });

  it("reports the fraction plus the same breakdown used to compute it", () => {
    const readout = contextReadout({
      messages: [{ role: "user", content: "x".repeat(350), timestamp: 1 }],
      contextWindow: 10_000,
      systemPrompt: "s".repeat(350),
      tools: [READ_TOOL],
      reserveTokens: 1_000,
    });

    expect(readout?.fraction).toBeCloseTo(0.1234, 10);
    expect(readout?.load.totalTokens).toBe(1_234);
    expect(readout?.contextWindow).toBe(10_000);
  });

  it("hides the readout until a transcript exists", () => {
    expect(contextReadout({ messages: [], contextWindow: 10_000, reserveTokens: 1_000 })).toBeUndefined();
    expect(contextReadout({ messages: [], contextWindow: 0, reserveTokens: 1_000 })).toBeUndefined();
  });

  it("uses the configured max tokens as the reserve, else the default", () => {
    expect(expectedOutputTokens({ maxTokens: 0 })).toBe(1_000);
    expect(expectedOutputTokens({ maxTokens: 123 })).toBe(123);
    expect(expectedOutputTokens(DEFAULT_SETTINGS)).toBe(1_000);
  });
});
