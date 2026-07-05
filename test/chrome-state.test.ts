import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import type { ToolBudgetSnapshot } from "../src/agent/tool-budget";
import {
  buildModelPillState,
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

    expect(formatChromeUsageText(usage, 0.004)).toBe("1000 tokens · 90% cache · $0.02 · next ~$0.0040");
    expect(formatChromeUsageText({ totalTokens: 0 } as Usage, 0)).toBe("");
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
