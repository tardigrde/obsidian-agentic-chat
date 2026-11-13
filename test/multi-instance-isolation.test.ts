import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { AgentRuntimeResourceState } from "../src/agent/runtime-resource-state";
import { AgentSubagentRuntime } from "../src/agent/subagent-runtime";
import type { AgentRuntimeResources } from "../src/agent/runtime-resources";
import type { AgentRole } from "../src/agent/subagents";
import type { AgentToolCallController } from "../src/agent/tool-call-controller";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings-schema";
import { ReadMemo } from "../src/vault/read-memo";
import type { WebFetcher } from "../src/tools/web-fetch";
import { FakeApp } from "./helpers/fake-vault";

const PROFILE: AgentRole = {
  name: "researcher",
  description: "test researcher",
  systemPrompt: "research",
  toolAllowlist: [],
};

const noopWebFetch: WebFetcher = async () => ({ status: 200, text: "", headers: {} });

const noopToolCalls: Pick<AgentToolCallController, "beforeToolCall" | "afterToolCall"> = {
  beforeToolCall: async () => undefined,
  afterToolCall: async () => undefined,
};

function resources(): AgentRuntimeResources {
  return {
    skills: [],
    plugins: [],
    profiles: [PROFILE],
    instructionsOverlay: "",
    ignoreMatcher: () => false,
    mcpTools: [],
    mcpDiagnostics: [],
  };
}

/** A child stream that stays open until its run signal aborts. */
function hangingStreamFn(onStart: () => void): StreamFn {
  return ((model: Model<"openai-completions">, _context: unknown, options?: { signal?: AbortSignal }) => {
    const stream = createAssistantMessageEventStream();
    const finish = (): void => {
      const message = {
        role: "assistant" as const,
        content: [] as { type: "text"; text: string }[],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    };
    onStart();
    const signal = options?.signal;
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
    return stream;
  }) as unknown as StreamFn;
}

function subagentRuntime(started: () => void): AgentSubagentRuntime {
  return new AgentSubagentRuntime({
    app: { vault: {}, workspace: {} } as unknown as App,
    getSettings: () => DEFAULT_SETTINGS,
    getResources: resources,
    buildStreamFn: () => hangingStreamFn(started),
    recordUsage: () => undefined,
    webFetch: noopWebFetch,
    toolCalls: noopToolCalls,
  });
}

function resourceState(settings: AgenticChatSettings, app: App): AgentRuntimeResourceState {
  return new AgentRuntimeResourceState({
    app,
    getSettings: () => settings,
    readMemo: new ReadMemo(),
    webFetch: noopWebFetch,
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("multi-instance isolation", () => {
  it("stops a subagent with a shared tool-call id in one runtime only", async () => {
    let startedA = 0;
    let startedB = 0;
    const runtimeA = subagentRuntime(() => {
      startedA += 1;
    });
    const runtimeB = subagentRuntime(() => {
      startedB += 1;
    });

    const first = runtimeA.createTool().execute("shared-call", { agent: "researcher", task: "A" });
    const second = runtimeB.createTool().execute("shared-call", { agent: "researcher", task: "B" });
    await waitFor(() => startedA === 1 && startedB === 1, "both children to start");

    runtimeA.abortChild("shared-call");
    const firstResult = await first;
    expect(firstResult.details.children[0].status).toBe("aborted");

    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondSettled).toBe(false);

    runtimeB.abortChild("shared-call");
    const secondResult = await second;
    expect(secondResult.details.children[0].status).toBe("aborted");
  });

  it("keeps loaded skills and clearSessionState per runtime resource state", async () => {
    const settings = DEFAULT_SETTINGS;
    const app = new FakeApp() as unknown as App;
    const stateA = resourceState(settings, app);
    const stateB = resourceState(settings, app);
    await stateA.reload();
    await stateB.reload();

    const [skillA, skillB] = stateA.getSkills();
    expect(skillA).toBeDefined();
    expect(skillB).toBeDefined();
    const markerA = skillA.content.slice(0, 80);
    const markerB = skillB.content.slice(0, 80);

    const loadA = stateA.buildParentTools(settings).find((tool) => tool.name === "load_skill");
    const loadB = stateB.buildParentTools(settings).find((tool) => tool.name === "load_skill");
    expect(loadA).toBeDefined();
    expect(loadB).toBeDefined();
    await loadA!.execute("load-a", { name: skillA.name });
    await loadB!.execute("load-b", { name: skillB.name });

    const promptA = stateA.composeSystemPrompt(settings, "model");
    const promptB = stateB.composeSystemPrompt(settings, "model");
    expect(promptA).toContain(markerA);
    expect(promptA).not.toContain(markerB);
    expect(promptB).toContain(markerB);
    expect(promptB).not.toContain(markerA);

    stateA.clearSessionState();
    expect(stateA.composeSystemPrompt(settings, "model")).not.toContain(markerA);
    expect(stateB.composeSystemPrompt(settings, "model")).toContain(markerB);
  });
});
