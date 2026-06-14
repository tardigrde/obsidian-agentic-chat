import { describe, expect, it } from "vitest";
import { buildModel, formatContextWindow, type ModelConfig } from "../src/llm/models";

const PRIVACY = { denyDataCollection: true, requireZDR: true, allowFallbacks: false };

function config(overrides: Partial<ModelConfig>): ModelConfig {
  return {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4",
    privacy: PRIVACY,
    ollamaBaseUrl: "http://localhost:11434",
    ...overrides,
  };
}

describe("buildModel — OpenRouter", () => {
  it("injects privacy routing into the model compat options", () => {
    const model = buildModel(config({}));
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("openrouter");
    expect(model.compat?.openRouterRouting).toEqual({
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
    });
  });

  it("omits deny/zdr when the privacy toggles are off", () => {
    const model = buildModel(config({ privacy: { denyDataCollection: false, requireZDR: false, allowFallbacks: true } }));
    expect(model.compat?.openRouterRouting).toEqual({ allow_fallbacks: true });
  });

  it("carries catalog pricing for a known model", () => {
    const model = buildModel(config({}));
    expect(model.cost.input).toBeGreaterThan(0);
  });

  it("synthesizes a model for ids missing from the catalog", () => {
    const model = buildModel(config({ modelId: "made-up/model" }));
    expect(model.baseUrl).toContain("openrouter.ai/api/v1");
    expect(model.cost.input).toBe(0);
    expect(model.compat?.openRouterRouting?.data_collection).toBe("deny");
  });
});

describe("formatContextWindow", () => {
  it("renders millions with an M suffix", () => {
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(2_000_000)).toBe("2M");
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
  });

  it("renders thousands with a k suffix", () => {
    expect(formatContextWindow(128_000)).toBe("128k");
    expect(formatContextWindow(8_192)).toBe("8k");
  });

  it("returns an empty string for unknown sizes", () => {
    expect(formatContextWindow(null)).toBe("");
    expect(formatContextWindow(0)).toBe("");
    expect(formatContextWindow(undefined)).toBe("");
  });
});

describe("buildModel — Ollama", () => {
  it("targets the local OpenAI-compatible endpoint at zero cost", () => {
    const model = buildModel(config({ provider: "ollama", modelId: "llama3.1", ollamaBaseUrl: "http://localhost:11434/" }));
    expect(model.provider).toBe("ollama");
    expect(model.baseUrl).toBe("http://localhost:11434/v1");
    expect(model.cost.input).toBe(0);
    expect(model.compat?.openRouterRouting).toBeUndefined();
  });
});
