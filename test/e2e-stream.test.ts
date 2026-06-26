import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
  createWindowE2EStreamFn,
  type E2EStreamTarget,
} from "../src/agent/e2e-stream";
import { replayTextTurn } from "../src/agent/replay-stream";

function model(): Model<"openai-completions"> {
  return {
    id: "test/model",
    name: "Test model",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_000,
  };
}

describe("createWindowE2EStreamFn", () => {
  it("does not activate scripted model turns unless the e2e stream flag is enabled", () => {
    const target: E2EStreamTarget = {
      __AGENTIC_CHAT_E2E_TURNS__: [replayTextTurn("production should ignore this")],
    };

    expect(createWindowE2EStreamFn({ enabled: false, target })).toBeUndefined();
    expect(target.__AGENTIC_CHAT_E2E_CALLS__).toBeUndefined();
    expect(target.__AGENTIC_CHAT_E2E_CALL_LOG__).toBeUndefined();
  });

  it("uses scripted model turns when an e2e build opts into the hook", async () => {
    const target: E2EStreamTarget = {
      __AGENTIC_CHAT_E2E_TURNS__: [replayTextTurn("scripted response")],
    };

    const streamFn = createWindowE2EStreamFn({ enabled: true, target });
    expect(streamFn).toBeTypeOf("function");

    const result = await (await streamFn!(model(), { messages: [] })).result();

    expect(result.content).toEqual([{ type: "text", text: "scripted response" }]);
    expect(target.__AGENTIC_CHAT_E2E_CALLS__).toBe(1);
    expect(target.__AGENTIC_CHAT_E2E_CALL_LOG__).toEqual([
      {
        index: 0,
        label: undefined,
        model: "test/model",
        provider: "openrouter",
        api: "openai-completions",
        systemPrompt: "",
        messageCount: 0,
        toolNames: [],
      },
    ]);
  });
});
