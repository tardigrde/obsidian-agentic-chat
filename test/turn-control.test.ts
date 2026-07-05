import { describe, expect, it } from "vitest";
import {
  normalizeModelOverride,
  promptRunBlockReason,
  resolveModelConfigForTurn,
  resolveThinkingLevelForTurn,
  normalizeSteeringText,
  spendCapAbortReason,
  steeringStatus,
  visibleModelOverride,
} from "../src/agent/turn-control";
import type { ModelConfig } from "../src/llm/models";

const BASE_CONFIG: ModelConfig = {
  provider: "openrouter",
  modelId: "default/model",
  privacy: { denyDataCollection: true, requireZDR: false, allowFallbacks: false },
  ollamaBaseUrl: "http://localhost:11434",
  openaiCompatibleBaseUrl: "http://localhost:3000/api",
};

describe("turn control", () => {
  it("reports prompt-run block reasons in execution order", () => {
    expect(
      promptRunBlockReason({
        isStreaming: true,
        hasApiKey: false,
        provider: "openrouter",
        spendCapUsd: 1,
        sessionCostUsd: 2,
      }),
    ).toBe("The agent is already responding.");

    expect(
      promptRunBlockReason({
        isStreaming: false,
        hasApiKey: false,
        provider: "openai-compatible",
        spendCapUsd: 1,
        sessionCostUsd: 2,
      }),
    ).toMatch(/openai-compatible API key/);

    expect(
      promptRunBlockReason({
        isStreaming: false,
        hasApiKey: true,
        provider: "openrouter",
        spendCapUsd: 0.01,
        sessionCostUsd: 0.02,
      }),
    ).toMatch(/Spend cap of \$0\.01 reached/);

    expect(
      promptRunBlockReason({
        isStreaming: false,
        hasApiKey: true,
        provider: "openrouter",
        spendCapUsd: 0.01,
        sessionCostUsd: 0.009,
      }),
    ).toBeUndefined();
  });

  it("reports in-flight spend-cap abort reasons only for streaming turns at or over the cap", () => {
    expect(spendCapAbortReason({ isStreaming: true, spendCapUsd: 0, sessionCostUsd: 1 })).toBeUndefined();
    expect(spendCapAbortReason({ isStreaming: false, spendCapUsd: 0.01, sessionCostUsd: 0.02 })).toBeUndefined();
    expect(spendCapAbortReason({ isStreaming: true, spendCapUsd: 0.01, sessionCostUsd: 0.009 })).toBeUndefined();
    expect(spendCapAbortReason({ isStreaming: true, spendCapUsd: 0.01, sessionCostUsd: 0.01 })).toBe(
      "Spend cap of $0.01 reached — stopped this turn.",
    );
  });

  it("normalizes and exposes model overrides for browseable providers", () => {
    expect(normalizeModelOverride("  anthropic/claude-sonnet  ")).toBe("anthropic/claude-sonnet");
    expect(normalizeModelOverride("   ")).toBeNull();
    expect(visibleModelOverride("openrouter", "anthropic/claude-sonnet")).toBe("anthropic/claude-sonnet");
    expect(visibleModelOverride("openai-compatible", "WARN-GLOBAL_kimi-k2.6")).toBe("WARN-GLOBAL_kimi-k2.6");
    expect(visibleModelOverride("ollama", "anthropic/claude-sonnet")).toBeNull();
  });

  it("applies model overrides only to browseable provider turn configs", () => {
    expect(resolveModelConfigForTurn(BASE_CONFIG, "anthropic/claude-sonnet").modelId).toBe("anthropic/claude-sonnet");
    expect(
      resolveModelConfigForTurn({ ...BASE_CONFIG, provider: "openai-compatible" }, "WARN-GLOBAL_kimi-k2.6").modelId,
    ).toBe("WARN-GLOBAL_kimi-k2.6");
    expect(resolveModelConfigForTurn({ ...BASE_CONFIG, provider: "ollama" }, "anthropic/claude-sonnet").modelId).toBe(
      "default/model",
    );
  });

  it("resolves one-shot thinking override and clamps to supported levels", () => {
    expect(resolveThinkingLevelForTurn("low", "high", ["off", "low", "high"])).toBe("high");
    expect(resolveThinkingLevelForTurn("low", "xhigh", ["off", "low", "medium"])).toBe("medium");
    expect(resolveThinkingLevelForTurn("low", null, ["off", "low", "high"])).toBe("low");
  });

  it("normalizes steering text and labels steering modes", () => {
    expect(normalizeSteeringText("  keep citations strict  ")).toBe("keep citations strict");
    expect(normalizeSteeringText("   ")).toBeNull();
    expect(steeringStatus("steer")).toBe("Queued for the active turn.");
    expect(steeringStatus("follow-up")).toBe("Queued as a follow-up.");
    expect(steeringStatus("redirect")).toBe("Redirecting the active turn.");
  });
});
