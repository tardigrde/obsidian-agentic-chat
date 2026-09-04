import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { App } from "obsidian";
import type { Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { AgentSubagentRuntime } from "../src/agent/subagent-runtime";
import type { AgentRuntimeResources } from "../src/agent/runtime-resources";
import type { AgentRole } from "../src/agent/subagents";
import type { ToolArtifactStoreLike } from "../src/artifacts/tool-artifact-store";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import type { WebFetcher } from "../src/tools/web-fetch";
import type { AgentToolCallController } from "../src/agent/tool-call-controller";

/** Arbitrary dispatch fixture — the name is test data, not a built-in role. */
const PROFILE: AgentRole = {
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

function resources(profiles: AgentRole[] = [PROFILE]): AgentRuntimeResources {
  return {
    skills: [],
    plugins: [],
    profiles,
    instructionsOverlay: "",
    memoryOverlay: "",
    ignoreMatcher: () => false,
    mcpTools: [],
    mcpDiagnostics: [],
  };
}

const noopWebFetch: WebFetcher = async () => ({ status: 200, text: "", headers: {} });

const noopToolCalls: Pick<AgentToolCallController, "beforeToolCall" | "afterToolCall"> = {
  beforeToolCall: async () => undefined,
  afterToolCall: async () => undefined,
};

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const artifactStore: ToolArtifactStoreLike = {  async writeArtifact(input) {
    return {
      id: "artifact-1",
      label: input.label,
      sourceToolName: input.sourceToolName,
      contentType: input.contentType ?? "text/plain",
      createdAt: "2026-06-27T00:00:00.000Z",
      charLength: input.text.length,
    };
  },
  async readArtifact() {
    return {
      metadata: {
        id: "artifact-1",
        label: "Artifact",
        sourceToolName: "tool",
        contentType: "text/plain",
        createdAt: "2026-06-27T00:00:00.000Z",
        charLength: 4,
      },
      text: "body",
    };
  },
  async listArtifacts() {
    return [
      {
        id: "artifact-1",
        label: "Artifact",
        sourceToolName: "tool",
        contentType: "text/plain",
        createdAt: "2026-06-27T00:00:00.000Z",
        charLength: 4,
      },
    ];
  },
};

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
  profiles?: AgentRole[];
  streamFn?: StreamFn;
  recordUsage?: (usage: { totalTokens: number }) => void;
  webFetch?: WebFetcher;
  artifactStore?: ToolArtifactStoreLike;
  toolCalls?: Pick<AgentToolCallController, "beforeToolCall" | "afterToolCall">;
} = {}): AgentSubagentRuntime {
  return new AgentSubagentRuntime({
    app: { vault: {}, workspace: {} } as unknown as App,
    getSettings: () => options.settings ?? settings(),
    getResources: () => resources(options.profiles),
    buildStreamFn: () => options.streamFn ?? cannedChildStream("ok"),
    recordUsage: (usage) => options.recordUsage?.(usage),
    webFetch: options.webFetch ?? noopWebFetch,
    artifactStore: options.artifactStore,
    toolCalls: options.toolCalls ?? noopToolCalls,
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

  it("routes child tool calls through parent hooks with per-child call id namespaces", async () => {
    const seen: string[] = [];
    const runtime = makeRuntime({
      toolCalls: {
        beforeToolCall: async (context) => {
          seen.push(`before:${context.toolCall.id}:${context.toolCall.name}:${JSON.stringify(context.args)}`);
          return { block: true, reason: "blocked by child gate" };
        },
        afterToolCall: async (context) => {
          seen.push(`after:${context.toolCall.id}:${context.isError ? "error" : "ok"}`);
          return undefined;
        },
      },
    });

    const firstChild = runtime.createChildAgent(PROFILE);
    const secondChild = runtime.createChildAgent(PROFILE);
    const beforeContext = {
      toolCall: { type: "toolCall", id: "call_1", name: "write", arguments: { path: "Other/x.md" } },
      args: { path: "Other/x.md" },
    } as unknown as Parameters<NonNullable<typeof firstChild.beforeToolCall>>[0];
    const afterContext = {
      toolCall: { type: "toolCall", id: "call_1", name: "write", arguments: { path: "Other/x.md" } },
      args: { path: "Other/x.md" },
      isError: true,
    } as unknown as Parameters<NonNullable<typeof firstChild.afterToolCall>>[0];

    await expect(firstChild.beforeToolCall?.(beforeContext)).resolves.toEqual({
      block: true,
      reason: "blocked by child gate",
    });
    await expect(secondChild.beforeToolCall?.(beforeContext)).resolves.toEqual({
      block: true,
      reason: "blocked by child gate",
    });
    await expect(firstChild.afterToolCall?.(afterContext)).resolves.toBeUndefined();
    await expect(secondChild.afterToolCall?.(afterContext)).resolves.toBeUndefined();
    expect(seen).toEqual([
      'before:subagent:1:call_1:write:{"path":"Other/x.md"}',
      'before:subagent:2:call_1:write:{"path":"Other/x.md"}',
      "after:subagent:1:call_1:error",
      "after:subagent:2:call_1:error",
    ]);
  });

  it("exposes enabled web and artifact lookup tools to allowlisted research children", () => {
    const profile: AgentRole = {
      name: "researcher",
      description: "Research",
      systemPrompt: "research",
      toolAllowlist: ["read", "web_search", "fetch_url", "list_artifacts", "read_artifact", "search_artifact"],
    };
    const runtime = makeRuntime({
      settings: settings({ web: { ...DEFAULT_SETTINGS.web, enabled: true } }),
      profiles: [profile],
      artifactStore,
    });

    const child = runtime.createChildAgent(profile);

    expect(child.state.tools.map((tool) => tool.name).sort()).toEqual([
      "fetch_url",
      "list_artifacts",
      "read",
      "read_artifact",
      "search_artifact",
      "web_search",
    ]);
  });


  it("keeps web tools out of children when web access is disabled", () => {
    const profile: AgentRole = {
      name: "researcher",
      description: "Research",
      systemPrompt: "research",
      toolAllowlist: ["read", "web_search", "fetch_url"],
    };
    const runtime = makeRuntime({ profiles: [profile] });

    const child = runtime.createChildAgent(profile);

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
