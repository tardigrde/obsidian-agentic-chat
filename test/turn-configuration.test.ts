import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { AgentTurnConfiguration } from "../src/agent/turn-configuration";
import type { ModelConfig } from "../src/llm/models";

function settings(overrides: Partial<AgenticChatSettings> = {}): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    openrouterModel: "default/model",
    ollamaModel: "llama3.1",
    thinkingLevel: "low",
    ...overrides,
  };
}

describe("AgentTurnConfiguration", () => {
  it("normalizes and exposes one-shot model overrides only for OpenRouter", () => {
    const state = settings();
    const turns = new AgentTurnConfiguration({ getSettings: () => state });

    turns.setModelOverride("  anthropic/claude-sonnet  ");

    expect(turns.getModelOverride()).toBe("anthropic/claude-sonnet");
    expect(turns.getActiveModelId()).toBe("anthropic/claude-sonnet");
    expect(turns.modelConfigForTurn().modelId).toBe("anthropic/claude-sonnet");

    state.provider = "ollama";

    expect(turns.getModelOverride()).toBeNull();
    expect(turns.getActiveModelId()).toBe("llama3.1");
    expect(turns.modelConfigForTurn().modelId).toBe("llama3.1");
  });

  it("clamps the active thinking level to the active model support", () => {
    const turns = new AgentTurnConfiguration({
      getSettings: () => settings({ thinkingLevel: "xhigh" }),
      resolveSupportedThinkingLevels: () => ["off", "low"],
    });

    expect(turns.getActiveThinkingLevel()).toBe("low");

    turns.setThinkingOverride("high");

    expect(turns.getActiveThinkingLevel()).toBe("low");
    expect(turns.getThinkingOverride()).toBe("high");
  });

  it("caches supported thinking levels by active model id", () => {
    let calls = 0;
    const turns = new AgentTurnConfiguration({
      getSettings: () => settings(),
      resolveSupportedThinkingLevels: (config: ModelConfig) => {
        calls += 1;
        return config.modelId === "override/model" ? ["off", "high"] : ["off", "low"];
      },
    });

    expect(turns.getActiveThinkingLevels()).toEqual(["off", "low"]);
    expect(turns.getActiveThinkingLevels()).toEqual(["off", "low"]);
    expect(calls).toBe(1);

    turns.setModelOverride("override/model");

    expect(turns.getActiveThinkingLevels()).toEqual(["off", "high"]);
    expect(calls).toBe(2);
  });

  it("consumes one-shot model and thinking overrides together", () => {
    const turns = new AgentTurnConfiguration({
      getSettings: () => settings(),
      resolveSupportedThinkingLevels: () => ["off", "low"],
    });

    turns.setModelOverride("override/model");
    turns.setThinkingOverride("high");
    turns.consumeOverrides();

    expect(turns.getModelOverride()).toBeNull();
    expect(turns.getThinkingOverride()).toBeNull();
    expect(turns.getActiveModelId()).toBe("default/model");
    expect(turns.getActiveThinkingLevel()).toBe("low");
  });
});
