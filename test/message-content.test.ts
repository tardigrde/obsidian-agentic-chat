import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  assistantUsage,
  collectToolResults,
  lastUserText,
  messageText,
  thinkingText,
  toolCalls,
  toolResultText,
} from "../src/ui/message-content";

const msg = (value: unknown): AgentMessage => value as unknown as AgentMessage;

describe("messageText", () => {
  it("returns string content directly", () => {
    expect(messageText(msg({ role: "user", content: "hello" }))).toBe("hello");
  });
  it("concatenates text blocks and ignores others", () => {
    const message = msg({
      role: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "thinking", thinking: "ignored" },
        { type: "text", text: "b" },
      ],
    });
    expect(messageText(message)).toBe("ab");
  });
  it("returns empty string for non-array, non-string content", () => {
    expect(messageText(msg({ role: "assistant", content: undefined }))).toBe("");
  });
});

describe("thinkingText", () => {
  it("concatenates thinking blocks only", () => {
    const message = msg({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "step1 " },
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "step2" },
      ],
    });
    expect(thinkingText(message)).toBe("step1 step2");
  });
});

describe("toolCalls", () => {
  it("extracts id/name/arguments from toolCall blocks", () => {
    const message = msg({
      role: "assistant",
      content: [
        { type: "text", text: "let me read" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.md" } },
      ],
    });
    expect(toolCalls(message)).toEqual([{ id: "c1", name: "read", arguments: { path: "a.md" } }]);
  });
  it("defaults missing fields", () => {
    const message = msg({ role: "assistant", content: [{ type: "toolCall" }] });
    expect(toolCalls(message)).toEqual([{ id: "", name: "", arguments: {} }]);
  });
});

describe("toolResultText", () => {
  it("returns string content directly", () => {
    expect(toolResultText({ content: "done" })).toBe("done");
  });
  it("joins text blocks with newlines", () => {
    expect(toolResultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe(
      "a\nb",
    );
  });
  it("returns empty string for missing content", () => {
    expect(toolResultText({})).toBe("");
    expect(toolResultText(null)).toBe("");
  });
});

describe("collectToolResults", () => {
  it("indexes toolResult messages by their call id with error flags", () => {
    const messages = [
      msg({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read" }] }),
      msg({ role: "toolResult", toolCallId: "c1", isError: false, content: "ok" }),
      msg({ role: "toolResult", toolCallId: "c2", isError: true, content: "boom" }),
    ];
    const map = collectToolResults(messages);
    expect(map.get("c1")).toEqual({ text: "ok", isError: false });
    expect(map.get("c2")).toEqual({ text: "boom", isError: true });
    expect(map.size).toBe(2);
  });
});

describe("assistantUsage", () => {
  it("returns usage only when tokens were recorded", () => {
    expect(assistantUsage(msg({ usage: { totalTokens: 0 } }))).toBeUndefined();
    expect(assistantUsage(msg({ usage: { totalTokens: 5 } }))).toEqual({ totalTokens: 5 });
    expect(assistantUsage(msg({}))).toBeUndefined();
  });
});

describe("lastUserText", () => {
  it("returns the most recent non-empty user message", () => {
    const messages = [
      msg({ role: "user", content: "first" }),
      msg({ role: "assistant", content: [{ type: "text", text: "reply" }] }),
      msg({ role: "user", content: "second" }),
      msg({ role: "assistant", content: [{ type: "text", text: "reply2" }] }),
    ];
    expect(lastUserText(messages)).toBe("second");
  });
  it("skips blank user turns", () => {
    const messages = [
      msg({ role: "user", content: "real" }),
      msg({ role: "user", content: "   " }),
    ];
    expect(lastUserText(messages)).toBe("real");
  });
  it("returns undefined when there is no user turn", () => {
    expect(lastUserText([msg({ role: "assistant", content: [] })])).toBeUndefined();
  });
});
