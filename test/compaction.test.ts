import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSummaryMessage,
  type CompactionConfig,
  isSummaryMessage,
  planCompaction,
} from "../src/agent/compaction";

const CONFIG: CompactionConfig = { enabled: true, thresholdFraction: 0.8, keepFraction: 0.3 };

/** A user message with `chars` characters of text (≈ chars/4 estimated tokens). */
function user(chars: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text: "x".repeat(chars) }], timestamp: 0 } as AgentMessage;
}

/** An assistant message with `chars` characters of text. */
function assistant(chars: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "y".repeat(chars) }],
    timestamp: 0,
  } as unknown as AgentMessage;
}

describe("planCompaction", () => {
  it("returns null when disabled", () => {
    const messages = [user(4000), assistant(4000), user(4000), assistant(4000)];
    expect(planCompaction(messages, 100, { ...CONFIG, enabled: false })).toBeNull();
  });

  it("returns null when the context window is unknown", () => {
    const messages = [user(4000), assistant(4000), user(4000), assistant(4000)];
    expect(planCompaction(messages, 0, CONFIG)).toBeNull();
  });

  it("returns null when still under the threshold", () => {
    // ~20 tokens against an 800-token threshold.
    const messages = [user(40), assistant(40), user(40), assistant(40)];
    expect(planCompaction(messages, 1000, CONFIG)).toBeNull();
  });

  it("returns null without at least two user turns to split", () => {
    // One giant user turn over threshold, but nothing safe to keep separately.
    const messages = [user(8000), assistant(8000)];
    expect(planCompaction(messages, 1000, CONFIG)).toBeNull();
  });

  it("splits at a user boundary, keeping recent turns within the keep budget", () => {
    // 10 messages × 100 tokens = 1000 tokens > 800 threshold; keep budget = 300.
    const messages = [
      user(400), assistant(400), // turn 1
      user(400), assistant(400), // turn 2
      user(400), assistant(400), // turn 3
      user(400), assistant(400), // turn 4
      user(400), assistant(400), // turn 5
    ];
    const plan = planCompaction(messages, 1000, CONFIG);
    expect(plan).not.toBeNull();
    // Keeps the last turn (200 tokens fits 300; adding turn 4 would be 400 > 300).
    expect(plan!.keep).toHaveLength(2);
    expect(plan!.keep[0].role).toBe("user");
    expect(plan!.summarize).toHaveLength(8);
    expect(plan!.tokensBefore).toBeGreaterThan(800);
  });

  it("never orphans a tool result: the kept slice always starts at a user turn", () => {
    const toolCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
      timestamp: 0,
    } as unknown as AgentMessage;
    const toolResult = {
      role: "toolResult",
      content: [{ type: "text", text: "z".repeat(800) }],
      timestamp: 0,
    } as unknown as AgentMessage;
    const messages = [
      user(800), assistant(800),
      user(800), toolCall, toolResult, assistant(800),
      user(800), assistant(800),
    ];
    const plan = planCompaction(messages, 1000, CONFIG);
    expect(plan).not.toBeNull();
    expect(plan!.keep[0].role).toBe("user");
  });
});

describe("buildSummaryMessage / isSummaryMessage", () => {
  it("wraps a summary as an identifiable user message", () => {
    const message = buildSummaryMessage("did some things", 123);
    expect(message.role).toBe("user");
    expect(isSummaryMessage(message)).toBe(true);
  });

  it("does not flag ordinary user messages as summaries", () => {
    expect(isSummaryMessage(user(10))).toBe(false);
    expect(isSummaryMessage(assistant(10))).toBe(false);
  });
});
