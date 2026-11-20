import { composerSendState } from "../src/ui/chat-chrome";
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

describe("composerSendState (U3 #12: the send button state machine)", () => {
  const rows: Array<[running: boolean, queued: boolean, draftEmpty: boolean, action: string, enabled: boolean, label: RegExp]> = [
    [false, false, true, "send", true, /^Send$/],
    [false, false, false, "send", true, /^Send$/],
    [false, true, false, "send", true, /^Send$/],
    [true, false, true, "queue", false, /type a message/],
    [true, false, false, "queue", true, /^Queue: send after this turn$/],
    [true, true, false, "update", true, /^Update the queued message$/],
    [true, true, true, "update", true, /^Update the queued message$/],
  ];
  it.each(rows)("running=%s queued=%s empty=%s -> %s, enabled=%s", (running, queued, draftEmpty, action, enabled, label) => {
    const state = composerSendState({ running, queued, draftEmpty });
    expect(state.action).toBe(action);
    expect(state.enabled).toBe(enabled);
    expect(state.label).toMatch(label);
    expect(state.icon).toBe(action === "send" ? "arrow-up" : "list-plus");
  });
});
