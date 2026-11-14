import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import type { ToolBudgetSnapshot } from "../src/agent/tool-budget";
import {
  buildModelPillState,
  buildTurnUsageChromeParts,
  cacheHitTone,
  modelProviderLabel,
  toolBudgetNotificationKey,
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

  it("maps cache-hit ratios to red/amber/green tones", () => {
    expect(cacheHitTone(0)).toBe("is-low");
    expect(cacheHitTone(49)).toBe("is-low");
    expect(cacheHitTone(50)).toBe("is-mid");
    expect(cacheHitTone(74)).toBe("is-mid");
    expect(cacheHitTone(75)).toBe("is-high");
    expect(cacheHitTone(100)).toBe("is-high");
  });

  it("builds the collapsed current-turn usage parts without session totals", () => {
    const usage = {
      totalTokens: 1_047,
      input: 900,
      cacheRead: 810,
      output: 147,
      cost: { total: 0.017, input: 0.01, output: 0.007 },
    } as Usage;
    expect(buildTurnUsageChromeParts(usage)).toEqual([
      { text: "1,047 tokens" },
      { text: "47% cache", cls: "agentic-chat-cache is-low" },
      { text: "$0.02" },
    ]);
    // No next-estimate projection, no session-wide cumulative line, no cost when unknown.
    expect(buildTurnUsageChromeParts({ totalTokens: 0 } as Usage)).toEqual([]);
    expect(buildTurnUsageChromeParts({ totalTokens: 100, input: 90 } as Usage)).toEqual([
      { text: "100 tokens" },
      { text: "0% cache", cls: "agentic-chat-cache is-low" },
    ]);
  });

  it("keys tool-budget notifications by dropped tool names only when active", () => {
    expect(toolBudgetNotificationKey(toolBudget({ active: false, droppedTools: [{ name: "web_search", reason: "budget" }] }))).toBeNull();
    expect(toolBudgetNotificationKey(toolBudget({ active: true, droppedTools: [] }))).toBeNull();
    expect(
      toolBudgetNotificationKey(toolBudget({
        active: true,
        droppedTools: [
          { name: "web_search", reason: "budget" },
          { name: "fetch_url", reason: "budget" },
        ],
      })),
    ).toBe("web_search,fetch_url");
  });
});

function toolBudget(overrides: Partial<ToolBudgetSnapshot>): ToolBudgetSnapshot {
  return {
    enabled: true,
    active: false,
    thresholdPercent: 2,
    triggeredAtToolSchemaPercent: null,
    toolSchemaTokens: null,
    contextWindow: null,
    droppedTools: [],
    ...overrides,
  };
}
