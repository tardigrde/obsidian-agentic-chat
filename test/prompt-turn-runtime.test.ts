import { describe, expect, it } from "vitest";
import type { Agent } from "@earendil-works/pi-agent-core";
import { AgentPromptTurnRuntime } from "../src/agent/prompt-turn-runtime";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";

interface Harness {
  runtime: AgentPromptTurnRuntime;
  agent: Agent;
  events: string[];
}

function harness(overrides: {
  settings?: Partial<AgenticChatSettings>;
  hasApiKey?: boolean;
  isStreaming?: boolean;
  sessionCostUsd?: number;
} = {}): Harness {
  const settings: AgenticChatSettings = {
    ...DEFAULT_SETTINGS,
    ...overrides.settings,
    notifications: {
      ...DEFAULT_SETTINGS.notifications,
      ...(overrides.settings?.notifications ?? {}),
    },
  };
  const events: string[] = [];
  const agent = { state: { isStreaming: overrides.isStreaming ?? false } } as Agent;
  const runtime = new AgentPromptTurnRuntime({
    requireAgent: () => agent,
    getSettings: () => settings,
    hasApiKey: () => overrides.hasApiKey ?? true,
    getSessionCostUsd: () => overrides.sessionCostUsd ?? 0,
    refreshConfiguration: async () => {
      events.push("refresh");
    },
    maybeCompact: async () => {
      events.push("compact");
    },
    clearError: () => {
      events.push("clear-error");
    },
    setError: (error) => {
      events.push(`set-error:${error instanceof Error ? error.message : String(error)}`);
    },
    setErrorMessage: (message) => {
      events.push(`set-error-message:${message}`);
    },
    consumeOverrides: () => {
      events.push("consume-overrides");
    },
    notifyChange: () => {
      events.push("notify");
    },
  });
  return { runtime, agent, events };
}

describe("AgentPromptTurnRuntime", () => {
  it("refreshes, compacts, runs, consumes overrides, and notifies around a successful turn", async () => {
    const { runtime, agent, events } = harness();

    await runtime.run(async (received) => {
      expect(received).toBe(agent);
      events.push("run");
    });

    expect(events).toEqual([
      "refresh",
      "compact",
      "clear-error",
      "notify",
      "run",
      "consume-overrides",
      "notify",
    ]);
  });

  it("blocks before refresh without consuming one-shot overrides", async () => {
    const { runtime, events } = harness({ hasApiKey: false });

    await runtime.run(async () => {
      events.push("run");
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(/^set-error-message:Add a openrouter API key/);
    expect(events[1]).toBe("notify");
  });

  it("captures run errors and still consumes one-shot overrides", async () => {
    const { runtime, events } = harness();

    await runtime.run(async () => {
      events.push("run");
      throw new Error("boom");
    });

    expect(events).toEqual([
      "refresh",
      "compact",
      "clear-error",
      "notify",
      "run",
      "set-error:boom",
      "consume-overrides",
      "notify",
    ]);
  });
});
