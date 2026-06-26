import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { AgentSubagentRuntime } from "../src/agent/subagent-runtime";
import type { AgentRuntimeResources } from "../src/agent/runtime-resources";
import type { AgentProfile } from "../src/agent/subagents";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";

const PROFILE: AgentProfile = {
  name: "editor",
  description: "Edit notes",
  systemPrompt: "child prompt",
  model: "child/model",
  toolAllowlist: ["read", "write"],
};

function settings(overrides: Partial<AgenticChatSettings> = {}): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    openrouterApiKey: "test-key",
    ...overrides,
    approval: { ...DEFAULT_SETTINGS.approval, ...(overrides.approval ?? {}) },
  };
}

function resources(profiles: AgentProfile[] = [PROFILE]): AgentRuntimeResources {
  return {
    skills: [],
    profiles,
    instructionsOverlay: "",
    ignoreMatcher: () => false,
    mcpTools: [],
    mcpDiagnostics: [],
  };
}

function cannedChildStream(text: string): StreamFn {
  return ((model: Model<"openai-completions">) => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 2,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  }) as unknown as StreamFn;
}

function makeRuntime(options: {
  settings?: AgenticChatSettings;
  profiles?: AgentProfile[];
  streamFn?: StreamFn;
  recordUsage?: (usage: { totalTokens: number }) => void;
} = {}): AgentSubagentRuntime {
  return new AgentSubagentRuntime({
    app: { vault: {}, workspace: {} } as unknown as App,
    getSettings: () => options.settings ?? settings(),
    getResources: () => resources(options.profiles),
    buildStreamFn: () => options.streamFn ?? cannedChildStream("ok"),
    recordUsage: (usage) => options.recordUsage?.(usage),
  });
}

describe("AgentSubagentRuntime", () => {
  it("creates child agents with profile prompt, model override, and parent-denied tools stripped", () => {
    const runtime = makeRuntime({
      settings: settings({
        mode: "safe",
        approval: { mutating: "allow", perTool: { write: "deny" }, workingDirs: [] },
      }),
    });

    const child = runtime.createChildAgent(PROFILE);

    expect(child.state.systemPrompt).toBe("child prompt");
    expect(child.state.model.id).toBe("child/model");
    expect(child.state.tools.map((tool) => tool.name).sort()).toEqual(["read"]);
  });

  it("creates a parent subagent tool wired to child creation and usage accounting", async () => {
    const usages: number[] = [];
    const runtime = makeRuntime({
      profiles: [{ ...PROFILE, name: "researcher", model: undefined, toolAllowlist: [] }],
      streamFn: cannedChildStream("child result"),
      recordUsage: (usage) => usages.push(usage.totalTokens),
    });

    const result = await runtime.createTool().execute("call-1", { agent: "researcher", task: "inspect notes" });

    expect(JSON.stringify(result.content)).toContain("child result");
    expect(usages).toEqual([5]);
  });
});
