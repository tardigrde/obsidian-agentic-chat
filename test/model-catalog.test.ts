import { describe, expect, it } from "vitest";
import { parseModelsPayload, type ParsedModel } from "../src/llm/model-catalog";

type Fixture = {
  name: string;
  row: Record<string, unknown>;
  expected: Partial<ParsedModel> & Pick<ParsedModel, "id" | "name" | "supportsTools" | "supportsReasoning" | "reasoningMetadata">;
};

const FIXTURES: Fixture[] = [
  {
    name: "full OpenRouter row",
    row: {
      id: "moonshotai/kimi-k2.6",
      name: "Kimi K2.6",
      context_length: 200_000,
      pricing: {
        prompt: "0.0000005",
        completion: "0.000001",
        input_cache_read: "0.0000001",
        input_cache_write: "0.0000002",
      },
      top_provider: { max_completion_tokens: 8_192 },
      supported_parameters: ["tools", "reasoning"],
      reasoning: { supported_efforts: ["low", "High", "unknown"] },
    },
    expected: {
      id: "moonshotai/kimi-k2.6",
      name: "Kimi K2.6",
      contextLength: 200_000,
      maxCompletionTokens: 8_192,
      pricing: { input: 0.5, output: 1, cacheRead: 0.1, cacheWrite: 0.2 },
      supportsTools: true,
      supportsReasoning: true,
      reasoningMetadata: true,
      thinkingLevelMap: { low: "low", high: "High" } as ParsedModel["thinkingLevelMap"],
    },
  },
  {
    name: "explicit reasoning flag without metadata",
    row: {
      id: "openai/gpt-4o",
      context_length: 128_000,
      supports_reasoning: true,
      supported_parameters: ["tools"],
    },
    expected: {
      id: "openai/gpt-4o",
      name: "openai/gpt-4o",
      contextLength: 128_000,
      maxCompletionTokens: 0,
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      supportsTools: true,
      supportsReasoning: true,
      // Pricing keeps its old heuristic: supports_reasoning alone is not metadata.
      reasoningMetadata: false,
      thinkingLevelMap: null,
    },
  },
  {
    name: "reasoning metadata without an explicit flag",
    row: {
      id: "local/model",
      reasoning: { supported_efforts: ["medium"] },
      maxTokens: 4_096,
    },
    expected: {
      id: "local/model",
      name: "local/model",
      contextLength: null,
      maxCompletionTokens: 4_096,
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      supportsTools: false,
      supportsReasoning: true,
      reasoningMetadata: true,
      thinkingLevelMap: { medium: "medium" } as ParsedModel["thinkingLevelMap"],
    },
  },
  {
    name: "empty id stays in the catalog and is dropped only by the pricing map",
    row: { id: "", name: "Nameless", context_length: 1_000 },
    expected: {
      id: "",
      name: "Nameless",
      contextLength: 1_000,
      maxCompletionTokens: 0,
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      supportsTools: false,
      supportsReasoning: false,
      reasoningMetadata: false,
      thinkingLevelMap: null,
    },
  },
];

describe("parseModelsPayload", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      expect(parseModelsPayload({ data: [fixture.row] })).toEqual([fixture.expected]);
    });
  }

  it("returns null for a malformed body and an empty list for a missing data field", () => {
    expect(parseModelsPayload(null)).toBeNull();
    expect(parseModelsPayload("not json")).toBeNull();
    expect(parseModelsPayload({ data: "not an array" })).toBeNull();
    expect(parseModelsPayload({ data: [{ id: 7 }] })).toBeNull();
    expect(parseModelsPayload({})).toEqual([]);
    expect(parseModelsPayload({ data: [] })).toEqual([]);
  });

  it("keeps pricing in per-million-token units with two decimals", () => {
    const [model] = parseModelsPayload({
      data: [{ id: "price/model", pricing: { prompt: "0.000012345", completion: "0.000099999" } }],
    }) ?? [];
    expect(model?.pricing.input).toBe(12.35);
    expect(model?.pricing.output).toBe(100);
  });
});
