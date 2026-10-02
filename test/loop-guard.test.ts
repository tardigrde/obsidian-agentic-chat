import { describe, expect, it } from "vitest";
import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import type { StopReason, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  AgentLoopGuard,
  buildLoopGuardNotice,
  fnv1a,
  stableStringify,
  toolBatchKey,
  toolBatchNames,
  toolResultKey,
} from "../src/agent/loop-guard";

function toolCallBlock(name: string, args: unknown, id = "c1"): { type: "toolCall"; id: string; name: string; arguments: unknown } {
  return { type: "toolCall", id, name, arguments: args };
}

function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    isError: false,
    timestamp: Date.now(),
    content: [textBlock(text)],
  };
}

function context(
  messageContent: { type: string; id?: string; name?: string; arguments?: unknown; text?: string }[],
  results: ReturnType<typeof toolResult>[],
  stopReason: StopReason = "toolUse",
): AgentTurnContext {
  return {
    message: { content: messageContent, stopReason },
    toolResults: results,
  } as unknown as AgentTurnContext;
}

/** `finishTurn` decides "stop" with `{ action: "end" }`; keep assertions readable. */
function stops(guard: AgentLoopGuard, turn: AgentTurnContext): boolean {
  return guard.finishTurn(turn)?.action === "end";
}

describe("stableStringify", () => {
  it("stringifies with sorted keys (argument key order does not matter)", () => {
    expect(stableStringify({ path: "x", action: "list" })).toBe(stableStringify({ action: "list", path: "x" }));
    expect(stableStringify({ action: "list" })).not.toBe(stableStringify({ action: "write" }));
    expect(stableStringify({ a: [2, 1], b: { d: 1, c: 2 } })).toBe('{"a":[2,1],"b":{"c":2,"d":1}}');
  });

  it("normalizes undefined/function values instead of returning undefined", () => {
    expect(stableStringify(undefined)).toBe("undefined");
    expect(stableStringify({ a: undefined })).toBe('{"a":undefined}');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof stableStringify((() => 1) as any)).toBe("string");
  });
});

describe("fnv1a", () => {
  it("is deterministic and distinguishes values", () => {
    expect(fnv1a("read")).toBe(fnv1a("read"));
    expect(fnv1a("read")).not.toBe(fnv1a("write"));
  });
});

describe("toolBatchKey", () => {
  it("returns null for a tool-free turn", () => {
    expect(toolBatchKey({ content: [textBlock("final answer")] })).toBeNull();
  });

  it("produces an ordered per-call key of name + hashed args", () => {
    const a = toolBatchKey({ content: [toolCallBlock("read", { path: "x" }), toolCallBlock("search", { query: "y" })] });
    const b = toolBatchKey({ content: [toolCallBlock("search", { query: "y" }), toolCallBlock("read", { path: "x" })] });
    expect(a).not.toBeNull();
    expect(a).not.toBe(b); // ordering matters
    expect(toolBatchKey({ content: [toolCallBlock("read", { path: "x" })] })).not.toBe(
      toolBatchKey({ content: [toolCallBlock("read", { path: "z" })] }),
    );
  });
});

describe("toolResultKey", () => {
  it("hashes result text in order and distinguishes changes", () => {
    const a = toolResultKey([toolResult("c1", "read", "same"), toolResult("c2", "search", "same")]);
    const b = toolResultKey([toolResult("c1", "read", "same"), toolResult("c2", "search", "changed")]);
    expect(a).not.toBe(b);
    expect(a).toBe(toolResultKey([toolResult("c1", "read", "same"), toolResult("c2", "search", "same")]));
  });
});

describe("AgentLoopGuard", () => {
  const batch = context(
    [toolCallBlock("read", { path: "A" }), toolCallBlock("search", { query: "#tag" })],
    [toolResult("c1", "read", "content A"), toolResult("c2", "search", "results 1")],
  );

  it("does not throw on malformed tool call blocks (missing arguments)", () => {
    const guard = new AgentLoopGuard({ maxIdenticalBatches: 2 });
    const malformed = context(
      // Block without `arguments` — must hash as `undefined`, not crash the hook.
      [{ type: "toolCall", id: "c1", name: "read" } as unknown as { type: string; id?: string; name?: string; arguments?: unknown; text?: string }],
      [toolResult("c1", "read", "content A")],
    );
    expect(stops(guard, malformed)).toBe(false);
    expect(stops(guard, malformed)).toBe(true); // identical malformed repeats still detected
    expect(guard.noticeText).not.toBeNull();
  });

  it("defaults to 4 identical batches before firing", () => {
    const guard = new AgentLoopGuard();
    expect(stops(guard, batch)).toBe(false);
    expect(stops(guard, batch)).toBe(false);
    expect(stops(guard, batch)).toBe(false);
    expect(stops(guard, batch)).toBe(true);
    expect(guard.noticeText).toMatch(/Loop guard/);
    expect(stops(guard, batch)).toBe(true); // stays fired
  });

  it("honors a custom threshold (fire on 2nd)", () => {
    const guard = new AgentLoopGuard({ maxIdenticalBatches: 2 });
    expect(stops(guard, batch)).toBe(false);
    expect(stops(guard, batch)).toBe(true);
  });

  it("does not fire when arguments change", () => {
    const guard = new AgentLoopGuard({ maxIdenticalBatches: 2 });
    expect(stops(guard, batch)).toBe(false);
    const different = context(
      [toolCallBlock("read", { path: "B" }), toolCallBlock("search", { query: "#tag" })],
      [toolResult("c1", "read", "content B"), toolResult("c2", "search", "results 1")],
    );
    expect(stops(guard, different)).toBe(false);
    expect(stops(guard, different)).toBe(true);
    expect(guard.noticeText).not.toBeNull();
  });

  it("does not fire when results change (polling), same args", () => {
    const guard = new AgentLoopGuard({ maxIdenticalBatches: 3 });
    const changedResult = context(
      [toolCallBlock("read", { path: "A" })],
      [toolResult("c1", "read", "content changed")],
    );
    expect(stops(guard, batch)).toBe(false);
    expect(stops(guard, changedResult)).toBe(false); // result changed — streak broken
    expect(stops(guard, batch)).toBe(false); // batch changed back — new streak
    expect(stops(guard, batch)).toBe(false);
    expect(stops(guard, batch)).toBe(true);
  });

  it("resets on a tool-free turn (model answered)", () => {
    const guard = new AgentLoopGuard({ maxIdenticalBatches: 2 });
    expect(stops(guard, batch)).toBe(false);
    expect(stops(guard, context([textBlock("final answer")], []))).toBe(false);
    expect(stops(guard, batch)).toBe(false); // streak restarted
    expect(stops(guard, batch)).toBe(true);
  });

  it("reset() clears the streak and the notice", () => {
    const guard = new AgentLoopGuard({ maxIdenticalBatches: 2 });
    guard.finishTurn(batch);
    guard.finishTurn(batch);
    expect(guard.noticeText).not.toBeNull();
    guard.reset();
    expect(guard.noticeText).toBeNull();
    expect(stops(guard, batch)).toBe(false);
  });

  it("exact-match only: same args with different result restarts the counter", () => {
    const guard = new AgentLoopGuard({ maxIdenticalBatches: 2 });
    const otherResult = context(
      [toolCallBlock("read", { path: "A" })],
      [toolResult("c1", "read", "different content")],
    );
    guard.finishTurn(context([toolCallBlock("read", { path: "A" })], [toolResult("c1", "read", "same")]));
    guard.finishTurn(otherResult);
    guard.finishTurn(otherResult);
    expect(guard.noticeText).not.toBeNull(); // two identical (args+result) turns still fire
  });

  it("names the repeated tools in the notice", () => {
    const guard = new AgentLoopGuard({ maxIdenticalBatches: 2 });
    guard.finishTurn(batch);
    guard.finishTurn(batch);
    expect(guard.noticeText).toMatch(/Loop guard.*read.*search/);
  });

  it("hints at approvals when every result is an error", () => {
    const denied = context(
      [toolCallBlock("write", { path: "loop.md" })],
      [{ ...toolResult("c1", "write", "denied"), isError: true }],
    );
    const guard = new AgentLoopGuard({ maxIdenticalBatches: 2 });
    guard.finishTurn(denied);
    guard.finishTurn(denied);
    expect(guard.noticeText).toMatch(/denied|approv/i);
  });

  it("error flag breaks the streak (same text, ok then err)", () => {
    const guard = new AgentLoopGuard({ maxIdenticalBatches: 2 });
    const ok = context([toolCallBlock("read", { path: "A" })], [toolResult("c1", "read", "same")]);
    const err = context(
      [toolCallBlock("read", { path: "A" })],
      [{ ...toolResult("c1", "read", "same"), isError: true }],
    );
    expect(stops(guard, ok)).toBe(false);
    expect(stops(guard, err)).toBe(false); // error flip restarts streak
    expect(stops(guard, err)).toBe(true);
  });

  it("toolBatchNames lists tools in call order", () => {
    expect(toolBatchNames({ content: [toolCallBlock("read", {}), toolCallBlock("search", {})] })).toEqual([
      "read",
      "search",
    ]);
    expect(toolBatchNames({ content: [textBlock("hi")] })).toEqual([]);
  });

  it("buildLoopGuardNotice stays short and single-message", () => {
    const text = buildLoopGuardNotice(["write"], 4, false);
    expect(text).toMatch(/Loop guard/);
    expect(text.length).toBeLessThan(300);
  });

  // pi 0.87.0 replaced `shouldStopAfterTurn` with `finishTurn`, which also runs
  // for error and aborted responses. Those are hard exits, so they must be
  // skipped: counting them would let a failing turn trip the streak, and the
  // predicate must stay side-effect free on hard exits.
  it.each(["error", "aborted"] as const)("ignores %s turns without touching the streak", (stopReason) => {
    const guard = new AgentLoopGuard({ maxIdenticalBatches: 2 });
    const failed = context(
      [toolCallBlock("read", { path: "A" })],
      [toolResult("c1", "read", "content A")],
      stopReason,
    );
    expect(guard.finishTurn(failed)).toBeUndefined();
    expect(guard.noticeText).toBeNull();
    // The failed turns must not have counted towards the threshold either.
    expect(stops(guard, batch)).toBe(false);
    expect(stops(guard, batch)).toBe(true);
  });
});
