import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import type { ToolBudgetSnapshot } from "../src/agent/tool-budget";
import {
  buildModelPillState,
  buildUsageChromeParts,
  cacheHitTone,
  folderButtonAriaLabel,
  formatChromeUsageText,
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

  it("formats the compact usage readout with optional next-cost estimate", () => {
    const usage = {
      totalTokens: 1000,
      input: 100,
      cacheRead: 900,
      cost: { total: 0.02 },
    } as Usage;

    expect(formatChromeUsageText(usage, { inputTokens: 100, outputTokens: 50, usd: 0.004 })).toBe(
      "1,000 tokens · 90% cache · $0.02 · next ~$0.0040",
    );
    expect(formatChromeUsageText({ totalTokens: 0 } as Usage, { inputTokens: 0, outputTokens: 0, usd: 0 })).toBe("");
    // Unknown pricing renders $? instead of hiding the row
    expect(formatChromeUsageText(usage, { inputTokens: 100, outputTokens: 50, usd: 0, isUnknown: true })).toBe(
      "1,000 tokens · 90% cache · $0.02 · next ~$?",
    );
  });

  it("maps cache-hit ratios to red/amber/green tones", () => {
    expect(cacheHitTone(0)).toBe("is-low");
    expect(cacheHitTone(49)).toBe("is-low");
    expect(cacheHitTone(50)).toBe("is-mid");
    expect(cacheHitTone(74)).toBe("is-mid");
    expect(cacheHitTone(75)).toBe("is-high");
    expect(cacheHitTone(100)).toBe("is-high");
  });

  it("builds structured usage parts with a colored cache chip and a tooltip on next-cost", () => {
    const usage = {
      totalTokens: 1000,
      input: 100,
      cacheRead: 900,
      cost: { total: 0.02 },
    } as Usage;

    expect(buildUsageChromeParts(usage, { inputTokens: 100, outputTokens: 50, usd: 0.004 })).toEqual([
      { text: "1,000 tokens" },
      { text: "90% cache", cls: "agentic-chat-cache is-high" },
      { text: "$0.02" },
      { text: "next ~$0.0040", cls: "agentic-chat-next-cost", title: "Projected cost of the next request (priced models only)." },
    ]);
    // A low cache hit takes the red tone.
    expect(buildUsageChromeParts({ totalTokens: 100, input: 90, cacheRead: 10 } as Usage)).toEqual([
      { text: "100 tokens" },
      { text: "10% cache", cls: "agentic-chat-cache is-low" },
    ]);
    expect(buildUsageChromeParts({ totalTokens: 0 } as Usage, { inputTokens: 0, outputTokens: 0, usd: 0 })).toEqual([]);
    // Unknown pricing renders $? with a tooltip
    expect(buildUsageChromeParts(usage, { inputTokens: 100, outputTokens: 50, usd: 0, isUnknown: true })).toEqual([
      { text: "1,000 tokens" },
      { text: "90% cache", cls: "agentic-chat-cache is-high" },
      { text: "$0.02" },
      { text: "next ~$?", cls: "agentic-chat-next-cost", title: "Pricing data unavailable for this model. Try again later or check your connection." },
    ]);
  });

  it("builds stable folder button labels", () => {
    expect(folderButtonAriaLabel(0)).toBe("Folders: working directory or attach listing");
    expect(folderButtonAriaLabel(1)).toBe("Folders · 1 working directory granted");
    expect(folderButtonAriaLabel(2)).toBe("Folders · 2 working directories granted");
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
