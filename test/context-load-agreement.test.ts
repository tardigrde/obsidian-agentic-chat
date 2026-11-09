import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentCompactionRuntime } from "../src/agent/compaction-runtime";
import { estimateContextUsage } from "../src/agent/compaction";
import { CachedContextOverheadCounter } from "../src/agent/readouts";
import { agentContextOverheadTokens, agentContextReadout } from "../src/agent/service-readouts";
import { estimateToolDefinitionTokens } from "../src/agent/tool-budget";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { MemoryAdapter } from "./helpers/memory-adapter";

const WINDOW = 10_000;

const settings: AgenticChatSettings = {
  ...DEFAULT_SETTINGS,
  openrouterApiKey: "test-key",
  openrouterModel: "test/model",
  maxTokens: 1_000,
  compaction: { ...DEFAULT_SETTINGS.compaction, enabled: true, thresholdPercent: 80 },
};

const model = {
  id: "test/model",
  name: "test/model",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: WINDOW,
  maxTokens: 1_000,
} as Model<Api>;

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 2,
  } as AgentMessage;
}

function tool(name: string, descriptionChars: number): AgentTool {
  return {
    name,
    label: name,
    description: "d".repeat(descriptionChars),
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  } as unknown as AgentTool;
}

async function runtime(): Promise<AgentCompactionRuntime> {
  const adapter = new MemoryAdapter();
  const manager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  await manager.createSession({ provider: "openrouter", modelId: "test/model", thinkingLevel: "off" });
  return new AgentCompactionRuntime({
    getSettings: () => settings,
    sessionManager: manager,
    summarize: async () => "Summary of earlier turns.",
  });
}

describe("context load agreement between the readout and compaction (#281)", () => {
  it("compacts when tool schemas push the readout past the threshold while the transcript alone is below it", async () => {
    const messages = [
      user("u".repeat(4_000)),
      assistant("a".repeat(4_000)),
      user("v".repeat(4_000)),
      assistant("b".repeat(4_000)),
    ];
    const tools = [tool("big_tool", 16_000)];
    const readout = agentContextReadout({ messages, model, settings, systemPrompt: "You are helpful.", tools });
    const threshold = WINDOW * 0.8;

    // Transcript alone is below the threshold; the full load the bar shows is above it.
    expect(estimateContextUsage(messages)).toBeLessThan(threshold);
    expect(readout!.load.totalTokens).toBeGreaterThan(threshold);

    const overheadTokens = agentContextOverheadTokens({ settings, systemPrompt: "You are helpful.", tools });
    expect(estimateContextUsage(messages) + overheadTokens).toBe(readout!.load.totalTokens);

    const result = await (await runtime()).compactWithResult(messages, WINDOW, { overheadTokens });
    expect(result.status).toBe("compacted");
  });

  it("reports the same load number as the context bar when nothing is compacted", async () => {
    const messages = [user("hello"), assistant("hi"), user("again"), assistant("ok")];
    const tools = [tool("small_tool", 400)];
    const systemPrompt = "s".repeat(2_000);
    const readout = agentContextReadout({ messages, model, settings, systemPrompt, tools });
    const overheadTokens = agentContextOverheadTokens({ settings, systemPrompt, tools });

    const result = await (await runtime()).compactWithResult(messages, WINDOW, { overheadTokens });

    expect(result).toMatchObject({ status: "skipped", reason: "no_plan" });
    expect(result.status === "skipped" && result.message).toContain(`(${readout!.load.totalTokens}/8000 estimated tokens)`);
  });

  it("does not re-summarize when only the overhead keeps the load above the threshold", async () => {
    // Transcript fits the keep budget (30% of the window); the overhead alone is
    // above the threshold. Folding the transcript again cannot help.
    const messages = [user("u".repeat(400)), assistant("a".repeat(400)), user("v".repeat(400))];
    const tools = [tool("huge_tool", 36_000)];
    const overheadTokens = agentContextOverheadTokens({ settings, systemPrompt: "", tools });

    const result = await (await runtime()).compactWithResult(messages, WINDOW, { overheadTokens });

    expect(result).toMatchObject({ status: "skipped", reason: "no_plan" });
    expect(result.status === "skipped" && result.message).toContain("compaction cannot shrink");
  });

  it("measures tool schemas once for unchanged inputs", () => {
    let calls = 0;
    const counter = new CachedContextOverheadCounter((tools) => {
      calls += 1;
      return estimateToolDefinitionTokens(tools);
    });
    const tools = [tool("a", 100), tool("b", 200)];
    const messages = [user("hello"), assistant("hi")];
    const input = { messages, model, settings, systemPrompt: "prompt", tools };

    const first = agentContextReadout(input, counter);
    const second = agentContextReadout(input, counter);
    expect(second).toEqual(first);
    expect(calls).toBe(1);

    // A new tool array (pi copies on every assignment) is measured again.
    const third = agentContextReadout({ ...input, tools: [...tools, tool("c", 300)] }, counter);
    expect(calls).toBe(2);
    expect(third!.load.toolSchemaTokens).toBeGreaterThan(first!.load.toolSchemaTokens);
  });
});

describe("checkCompactionDue hysteresis (#281)", () => {
  const config = { enabled: true, thresholdFraction: 0.8, keepFraction: 0.3 };
  const words = (tokens: number) => "word ".repeat(tokens);

  it("does not re-trigger right after a compaction when overhead keeps the load high", async () => {
    const { checkCompactionDue } = await import("../src/agent/compaction");
    // Right after compaction: kept turns (~keep budget) plus a summary slightly over it.
    const messages = [user(words(600)), assistant(words(600)), user(words(600)), assistant(words(600))];
    const transcript = estimateContextUsage(messages);
    const keep = WINDOW * config.keepFraction;
    expect(transcript).toBeGreaterThan(keep);
    expect(transcript - keep).toBeLessThan(WINDOW * 0.1);
    const overhead = WINDOW * 0.8 - transcript + 1; // load just over the threshold
    expect(checkCompactionDue(messages, WINDOW, config, overhead).reason).toBe("overhead_bound");
  });

  it("still compacts on overhead when compaction frees a meaningful share of the window", async () => {
    const { checkCompactionDue } = await import("../src/agent/compaction");
    const messages = [user(words(1500)), assistant(words(1500)), user(words(1500)), assistant(words(1500))];
    const transcript = estimateContextUsage(messages);
    expect(transcript - WINDOW * config.keepFraction).toBeGreaterThan(WINDOW * 0.1);
    const overhead = WINDOW * 0.8 - transcript + 1;
    expect(checkCompactionDue(messages, WINDOW, config, overhead).reason).toBe("due");
  });
});
