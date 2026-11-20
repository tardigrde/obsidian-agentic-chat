import { describe, expect, it } from "vitest";
import {
  buildModelPillState,
  modelProviderLabel,
} from "../src/ui/chrome-state";

describe("chrome state helpers", () => {
  it("labels providers and next-turn model overrides for the model pill", () => {
    expect(modelProviderLabel("ollama")).toBe("Ollama");
    expect(modelProviderLabel("openai-compatible")).toBe("OpenAI-compatible");
    expect(modelProviderLabel("openrouter")).toBe("OpenRouter");

    expect(
      buildModelPillState({
        provider: "openrouter",
        activeModelId: "anthropic/claude-opus-4",
      }),
    ).toEqual({
      providerLabel: "OpenRouter",
      fullModel: "anthropic/claude-opus-4",
      shortModel: "claude-opus-4",
      title: "OpenRouter · anthropic/claude-opus-4",
      isOverride: false,
    });

    expect(
      buildModelPillState({
        provider: "openrouter",
        activeModelId: "anthropic/claude-opus-4",
        overrideModelId: "openai/gpt-5",
      }),
    ).toMatchObject({
      providerLabel: "next only",
      fullModel: "openai/gpt-5",
      shortModel: "gpt-5",
      isOverride: true,
    });
  });

});
