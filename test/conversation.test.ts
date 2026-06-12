import { describe, expect, it } from "vitest";
import { ConversationStore } from "../src/state/conversation";
import type { Usage } from "../src/agent/types";

const usage: Usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, requests: 2 };

describe("ConversationStore", () => {
  it("records user messages with attachments", () => {
    const store = new ConversationStore();
    store.addUser("hi", ["a.md", "folder:Projects"]);

    expect(store.items).toEqual([
      { kind: "user", text: "hi", attachments: ["a.md", "folder:Projects"] },
    ]);
  });

  it("folds a full agent event stream into one assistant item", () => {
    const store = new ConversationStore();
    store.addUser("go");
    store.beginAssistant();

    store.applyAgentEvent({ type: "run_start", prompt: "go" });
    store.applyAgentEvent({ type: "step_start", step: 1 });
    store.applyAgentEvent({
      type: "tool_call_start",
      id: "c1",
      name: "read_note",
      arguments: '{"path":"a.md"}',
    });
    store.applyAgentEvent({
      type: "tool_call_end",
      id: "c1",
      name: "read_note",
      result: "alpha",
      isError: false,
    });
    store.applyAgentEvent({ type: "step_start", step: 2 });
    store.applyAgentEvent({ type: "reasoning_delta", delta: "hmm " });
    store.applyAgentEvent({ type: "text_delta", delta: "Answ" });
    store.applyAgentEvent({ type: "text_delta", delta: "er" });
    store.applyAgentEvent({ type: "run_end", output: "Answer", usage });

    const item = store.lastAssistant;
    expect(item).toMatchObject({
      kind: "assistant",
      text: "Answer",
      reasoning: "hmm ",
      status: "done",
      usage,
    });
    expect(item?.steps).toEqual([
      {
        id: "c1",
        name: "read_note",
        arguments: '{"path":"a.md"}',
        status: "done",
        result: "alpha",
      },
    ]);
  });

  it("marks failed tool calls as errors", () => {
    const store = new ConversationStore();
    store.beginAssistant();
    store.applyAgentEvent({ type: "tool_call_start", id: "c1", name: "x", arguments: "{}" });
    store.applyAgentEvent({
      type: "tool_call_end",
      id: "c1",
      name: "x",
      result: "nope",
      isError: true,
    });

    expect(store.lastAssistant?.steps[0]).toMatchObject({ status: "error", result: "nope" });
  });

  it("records run errors on the streaming item", () => {
    const store = new ConversationStore();
    store.beginAssistant();
    store.applyAgentEvent({ type: "text_delta", delta: "partial" });
    store.applyAgentEvent({ type: "run_error", message: "rate limit" });

    expect(store.lastAssistant).toMatchObject({
      status: "error",
      error: "rate limit",
      text: "partial",
    });
  });

  it("markStopped overrides an error status and stops running steps", () => {
    const store = new ConversationStore();
    store.beginAssistant();
    store.applyAgentEvent({ type: "tool_call_start", id: "c1", name: "x", arguments: "{}" });
    store.applyAgentEvent({ type: "run_error", message: "The run was aborted." });
    store.markStopped();

    expect(store.lastAssistant).toMatchObject({ status: "stopped", error: undefined });
    expect(store.lastAssistant?.steps[0].status).toBe("error");
  });

  it("markStopped never downgrades a completed turn", () => {
    const store = new ConversationStore();
    store.beginAssistant();
    store.applyAgentEvent({ type: "run_end", output: "done", usage });
    store.markStopped();

    expect(store.lastAssistant?.status).toBe("done");
  });

  it("reset clears all items", () => {
    const store = new ConversationStore();
    store.addUser("hi");
    store.beginAssistant();
    store.reset();

    expect(store.items).toHaveLength(0);
    expect(store.lastAssistant).toBeUndefined();
  });
});
