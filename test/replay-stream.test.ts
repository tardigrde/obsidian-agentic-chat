import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
  createReplayStreamController,
  replayErrorTurn,
  replayTextTurn,
  replayToolCallTurn,
} from "../src/agent/replay-stream";

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

describe("createReplayStreamController", () => {
  it("emits deterministic text/tool-call update events and records provider calls", async () => {
    const replay = createReplayStreamController([
      {
        ...replayToolCallTurn("call-1", "read", { path: "Note.md" }),
        label: "parent reads note",
        emitUpdates: true,
      },
    ], { now: () => 123 });

    const stream = replay.streamFn(model(), {
      systemPrompt: "parent prompt",
      messages: [{ role: "user", content: "read it", timestamp: 1 }],
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
    });

    const events = [];
    for await (const event of await stream) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    expect(replay.calls).toEqual([
      {
        index: 0,
        label: "parent reads note",
        model: "test/model",
        provider: "openrouter",
        api: "openai-completions",
        systemPrompt: "parent prompt",
        messageCount: 1,
        toolNames: ["read"],
      },
    ]);
  });

  it("encodes scripted errors and missing turns as final assistant error messages", async () => {
    const replay = createReplayStreamController([replayErrorTurn("scripted failure", { timestamp: 10 })]);
    const first = replay.streamFn(model(), { messages: [] });
    const firstEvents = [];
    for await (const event of await first) firstEvents.push(event);
    expect(firstEvents.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      error: { errorMessage: "scripted failure", timestamp: 10 },
    });

    const missing = replay.streamFn(model(), { messages: [] });
    const missingEvents = [];
    for await (const event of await missing) missingEvents.push(event);
    expect(missingEvents.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      error: { errorMessage: "No scripted replay stream turn at index 1." },
    });
  });

  it("can preserve old terse test behavior by repeating the last turn", async () => {
    const replay = createReplayStreamController([replayTextTurn("same")], { missingTurn: "repeat-last" });

    const first = await (await replay.streamFn(model(), { messages: [] })).result();
    const second = await (await replay.streamFn(model(), { messages: [] })).result();

    expect(first.content).toEqual([{ type: "text", text: "same" }]);
    expect(second.content).toEqual([{ type: "text", text: "same" }]);
  });

  it("can start from an absolute turn index when a harness rebuilds the stream", async () => {
    const replay = createReplayStreamController(
      [replayTextTurn("first"), replayTextTurn("second")],
      { initialTurnIndex: 1 },
    );

    const result = await (await replay.streamFn(model(), { messages: [] })).result();

    expect(result.content).toEqual([{ type: "text", text: "second" }]);
    expect(replay.calls.map((call) => call.index)).toEqual([1]);
    expect(replay.remainingTurns()).toBe(0);
  });
});
