import { describe, expect, it } from "vitest";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { AgentParentConfigurationRuntime } from "../src/agent/parent-agent-configuration";
import type { ParentAgentRuntime } from "../src/agent/parent-agent-runtime";
import { EMPTY_AGENT_RUNTIME_RESOURCES } from "../src/agent/runtime-resources";
import type { AgentProfile } from "../src/agent/subagents";
import type { SessionInfo } from "../src/session/session-manager";
import { DEFAULT_SETTINGS } from "../src/settings";

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
          } satisfies AgentProfile,
        ],
        composeSystemPrompt: (_settings, modelId) => `system:${modelId}`,
        buildParentTools: (_settings, suppliedSubagentTool) => [readTool, suppliedSubagentTool].filter(Boolean) as AgentTool[],
        reload: async () => EMPTY_AGENT_RUNTIME_RESOURCES,
      },
      subagents: { createTool: () => subagentTool },
      toolCalls: {
        beforeToolCall: async () => undefined,
        afterToolCall: async () => undefined,
      },
      sessions: {
        info: session,
        ensureConfiguration: async () => session,
      },
      onEvent: () => undefined,
    });

    const configuration = runtime.build();

    expect(configuration.streamFn).toBe(streamFn);
    expect(configuration.model).toBe(model);
    expect(configuration.thinkingLevel).toBe("low");
    expect(configuration.systemPrompt).toBe("system:model-a");
    expect(configuration.tools.map((tool) => tool.name)).toEqual(["read", "subagent"]);
    expect(configuration.sessionId).toBe("session-1");
    expect(configuration.getApiKey("openrouter")).toBe("key");
  });

  it("reloads resources before refreshing the live parent agent and session config", async () => {
    const events: string[] = [];
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
        reload: async () => {
          events.push("reload-resources");
          return EMPTY_AGENT_RUNTIME_RESOURCES;
        },
      },
      subagents: { createTool: () => ({ name: "subagent" }) as AgentTool },
      toolCalls: {
        beforeToolCall: async () => undefined,
        afterToolCall: async () => undefined,
      },
      sessions: {
        info: session,
        ensureConfiguration: async () => {
          events.push("ensure-session-config");
          return session;
        },
      },
      onEvent: () => undefined,
    });
    const parentAgent = {
      requireAgent: () => {
        events.push("require-agent");
        return {};
      },
      refreshConfiguration: () => {
        events.push("refresh-agent");
        return {};
      },
    } as unknown as ParentAgentRuntime;

    await runtime.refresh(parentAgent);

    expect(events).toEqual([
      "require-agent",
      "reload-resources",
      "refresh-agent",
      "ensure-session-config",
    ]);
  });
});
