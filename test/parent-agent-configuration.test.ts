import { describe, expect, it } from "vitest";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { AgentParentConfigurationRuntime } from "../src/agent/parent-agent-configuration";
import type { AgentRole } from "../src/agent/subagents";
import type { SessionInfo } from "../src/session/session-manager";
import { DEFAULT_SETTINGS } from "../src/settings-schema";

describe("AgentParentConfigurationRuntime", () => {
  it("builds the parent agent configuration from the current runtime collaborators", () => {
    const streamFn = (() => {
      throw new Error("unused streamFn");
    }) as StreamFn;
    const model = {
      provider: "openrouter",
      api: "openai-completions",
      id: "model-a",
      contextWindow: 1000,
    } as unknown as Model<"openai-completions">;
    const subagentTool = { name: "subagent" } as AgentTool;
    const readTool = { name: "read" } as AgentTool;
    const session = { id: "session-1" } as SessionInfo;
    let receivedContextWindow: number | undefined;
    const runtime = new AgentParentConfigurationRuntime({
      getSettings: () => ({ ...DEFAULT_SETTINGS, openrouterApiKey: "key" }),
      streams: { buildStreamFn: () => streamFn },
      turns: {
        getActiveModelId: () => "model-a",
        buildModelForTurn: () => model,
        thinkingLevelForTurn: () => "low",
      },
      runtimeResources: {
        getProfiles: () => [
          {
            name: "researcher",
            description: "Research",
            systemPrompt: "Research",
            toolAllowlist: [],
          } satisfies AgentRole,
        ],
        composeSystemPrompt: (_settings, modelId) => `system:${modelId}`,
        buildParentTools: (_settings, suppliedSubagentTool, options) => {
          receivedContextWindow = options?.contextWindow;
          return [readTool, suppliedSubagentTool].filter(Boolean) as AgentTool[];
        },
      },
      subagents: { createTool: () => subagentTool },
      toolCalls: {
        beforeToolCall: async () => undefined,
        afterToolCall: async () => undefined,
        consumeStopRequested: () => false,
      },
      loopGuard: { finishTurn: () => undefined },
      turnCap: { shouldStopAfterTurn: () => false },
      sessions: { info: session },
      onEvent: () => undefined,
    });

    const configuration = runtime.build();

    expect(configuration.streamFn).toBe(streamFn);
    expect(configuration.model).toBe(model);
    expect(configuration.thinkingLevel).toBe("low");
    expect(configuration.systemPrompt).toBe("system:model-a");
    expect(configuration.tools.map((tool) => tool.name)).toEqual(["read", "subagent"]);
    expect(receivedContextWindow).toBe(1000);
    expect(configuration.sessionId).toBe("session-1");
    expect(configuration.getApiKey("openrouter")).toBe("key");
  });

  it("ends the turn when a stopped approval left a stop request", () => {
    let loopCalls = 0;
    const session = { id: "session-1" } as SessionInfo;
    const runtime = new AgentParentConfigurationRuntime({
      getSettings: () => DEFAULT_SETTINGS,
      streams: { buildStreamFn: () => (() => undefined) as unknown as StreamFn },
      turns: {
        getActiveModelId: () => "model-a",
        buildModelForTurn: () => ({}) as Model<"openai-completions">,
        thinkingLevelForTurn: () => "off",
      },
      runtimeResources: {
        getProfiles: () => [],
        composeSystemPrompt: () => "",
        buildParentTools: () => [],
      },
      subagents: { createTool: () => ({ name: "subagent" }) as AgentTool },
      toolCalls: {
        beforeToolCall: async () => undefined,
        afterToolCall: async () => undefined,
        consumeStopRequested: () => true,
      },
      loopGuard: {
        finishTurn: () => {
          loopCalls += 1;
          return undefined;
        },
      },
      turnCap: { shouldStopAfterTurn: () => false },
      sessions: { info: session },
      onEvent: () => undefined,
    });

    const decision = runtime.build().finishTurn?.({} as never);

    expect(decision).toEqual({ action: "end" });
    expect(loopCalls).toBe(0);
  });

});
