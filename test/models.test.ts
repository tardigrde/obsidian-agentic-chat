import { describe, expect, it } from "vitest";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  buildModel,
  clampThinkingLevel,
  formatContextWindow,
  listOpenRouterModels,
  ModelListError,
  supportedThinkingLevels,
  type ModelConfig,
} from "../src/llm/models";

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

describe("supportedThinkingLevels", () => {
  it("offers only off for a non-reasoning model", () => {
    const ollama = buildModel(config({ provider: "ollama" }));
    expect(supportedThinkingLevels(ollama)).toEqual(["off"]);
  });

  it("offers the full ladder for a reasoning model with no level map", () => {
    expect(supportedThinkingLevels({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("drops levels the thinkingLevelMap marks null (unsupported)", () => {
    const map: Partial<Record<ThinkingLevel, string | null>> = {
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    };
    expect(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: map })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("keeps missing map entries (provider default applies)", () => {
    const map: Partial<Record<ThinkingLevel, string | null>> = { xhigh: null };
    const levels = supportedThinkingLevels({ reasoning: true, thinkingLevelMap: map });
    expect(levels).not.toContain("xhigh");
    expect(levels).toContain("high");
    expect(levels[0]).toBe("off");
  });
});

describe("clampThinkingLevel", () => {
  it("returns the requested level when supported", () => {
    expect(clampThinkingLevel("high", ["off", "low", "high"])).toBe("high");
  });

  it("clamps downward to the nearest supported level", () => {
    // xhigh unsupported → fall to high
    expect(clampThinkingLevel("xhigh", ["off", "low", "high"])).toBe("high");
    // medium unsupported → fall to low
    expect(clampThinkingLevel("medium", ["off", "low", "high"])).toBe("low");
  });

  it("falls back to off when nothing equal-or-lower is supported", () => {
    expect(clampThinkingLevel("low", ["off", "high"])).toBe("off");
  });

  it("always resolves off for a non-reasoning model's supported set", () => {
    expect(clampThinkingLevel("xhigh", ["off"])).toBe("off");
  });
});

describe("listOpenRouterModels", () => {
  function fakeFetch(captured: { url?: string }): typeof fetch {
    return (async (url: string) => {
      captured.url = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6", context_length: 200_000, supported_parameters: ["tools"] },
          ],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("requests the ZDR-filtered catalog when zdr is set", async () => {
    const captured: { url?: string } = {};
    const models = await listOpenRouterModels("key", { fetchImpl: fakeFetch(captured), zdr: true });
    expect(captured.url).toContain("/models?zdr=true");
    expect(models[0]).toMatchObject({ id: "moonshotai/kimi-k2.6", supportsTools: true, contextLength: 200_000 });
  });

  it("requests the full catalog when zdr is off", async () => {
    const captured: { url?: string } = {};
    await listOpenRouterModels("key", { fetchImpl: fakeFetch(captured) });
    expect(captured.url).toMatch(/\/models$/);
    expect(captured.url).not.toContain("zdr");
  });

  it("filters by data_collection=deny when denyDataCollection is set", async () => {
    const captured: { url?: string } = {};
    await listOpenRouterModels("key", { fetchImpl: fakeFetch(captured), denyDataCollection: true });
    expect(captured.url).toContain("data_collection=deny");
  });

  it("combines zdr and data_collection filters", async () => {
    const captured: { url?: string } = {};
    await listOpenRouterModels("key", { fetchImpl: fakeFetch(captured), zdr: true, denyDataCollection: true });
    expect(captured.url).toContain("zdr=true");
    expect(captured.url).toContain("data_collection=deny");
  });

  it("wraps a malformed JSON body in a ModelListError instead of throwing raw", async () => {
    const badFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(listOpenRouterModels("key", { fetchImpl: badFetch })).rejects.toBeInstanceOf(ModelListError);
  });

  it("recognizes plain AbortError objects as timeouts", async () => {
    const abortingFetch = (async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;
    await expect(listOpenRouterModels("key", { fetchImpl: abortingFetch })).rejects.toMatchObject({
      name: "ModelListError",
      status: 408,
    });
  });

  it("returns an empty list when the body is JSON null", async () => {
    const nullFetch = (async () =>
      ({ ok: true, status: 200, json: async () => null }) as unknown as Response) as unknown as typeof fetch;
    await expect(listOpenRouterModels("key", { fetchImpl: nullFetch })).resolves.toEqual([]);
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
