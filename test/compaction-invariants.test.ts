import { describe, expect, it } from "vitest";
import { estimateTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
  buildSummaryMessage,
  type CompactionConfig,
  getCompactedUsage,
  isSummaryMessage,
  planCompaction,
} from "../src/agent/compaction";

/**
 * First-principles tests for compaction + context rebuild (src/agent/compaction.ts).
 *
 * Contract (AGENTS.md + compaction.ts JSDoc): compaction is the loop's memory.
 * Across a compaction boundary nothing may be lost or hallucinated, message order
 * is preserved, and assistant/tool-result pairs are never orphaned — the cut point
 * is always a user-message boundary, so the retained slice stays a valid model
 * context. summarize folds older turns into one message; keep retains the recent
 * ones within a token budget (always at least the final turn).
 */

const CONFIG: CompactionConfig = { enabled: true, thresholdFraction: 0.8, keepFraction: 0.3 };
// estimateTokens ≈ chars/4 for text; user(N)/assistant(N) yield N/4 tokens each.
const WINDOW = 1000;
const KEEP_BUDGET = WINDOW * CONFIG.keepFraction; // 300

function user(chars: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text: "u".repeat(chars) }], timestamp: 0 } as AgentMessage;
}
function assistant(chars: number): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text: "a".repeat(chars) }], timestamp: 0 } as unknown as AgentMessage;
}

/** A turn that drives a tool: assistant emits a toolCall, a toolResult follows. */
function toolTurn(callId: string, chars: number): AgentMessage[] {
  const call = {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `${callId}.md` } }],
    timestamp: 0,
  } as unknown as AgentMessage;
  const result = {
    role: "toolResult",
    content: [{ type: "text", text: "r".repeat(chars), toolCallId: callId }],
    timestamp: 0,
  } as unknown as AgentMessage;
  return [call, result];
}

/** Stable signature for loss/order comparison (role + any text + any toolCall id). */
function signature(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return `${message.role}|string:${content}`;
  const blocks = Array.isArray(content) ? content : [];
  const parts = blocks.map((b) => {
    const block = b as { type?: unknown; text?: unknown; id?: unknown };
    return `${block.type}:${block.text ?? block.id ?? ""}`;
  });
  return `${message.role}|${parts.join("§")}`;
}

describe("compaction loses nothing, duplicates nothing, preserves order", () => {
  const scenarios: Array<{ name: string; messages: AgentMessage[] }> = [
    {
      name: "plain alternating turns",
      messages: Array.from({ length: 10 }, () => [user(400), assistant(400)]).flat(),
    },
    {
      name: "turns with tool calls and results",
      messages: [
        user(400), ...toolTurn("c1", 400), assistant(400),
        user(400), ...toolTurn("c2", 400), assistant(400),
        user(400), ...toolTurn("c3", 400), assistant(400),
        user(400), assistant(400),
      ],
    },
  ];

  for (const { name, messages } of scenarios) {
    it(name, () => {
      const plan = planCompaction(messages, WINDOW, CONFIG);
      expect(plan).not.toBeNull();
      // Concatenating the two slices must reproduce the transcript exactly: same
      // messages, same order, nothing dropped, nothing fabricated.
      const rebuilt = [...plan!.summarize, ...plan!.keep];
      expect(rebuilt.map(signature)).toEqual(messages.map(signature));
    });
  }
});

describe("compaction never orphans a tool-call/result pair", () => {
  it("the cut always lands on a user boundary and never splits a call from its result", () => {
    const messages = [
      user(400), ...toolTurn("c1", 400), assistant(400),
      user(400), ...toolTurn("c2", 400), assistant(400),
      user(400), ...toolTurn("c3", 400), assistant(400),
      user(400), assistant(400),
    ];
    const plan = planCompaction(messages, WINDOW, CONFIG);
    expect(plan).not.toBeNull();
    const cut = plan!.summarize.length;

    // Contract: the retained slice always begins at a user turn.
    expect(plan!.keep[0].role).toBe("user");

    // The boundary between the slices must never sit between a toolCall-bearing
    // assistant message and the toolResult that answers it.
    const before = messages[cut - 1];
    const after = messages[cut];
    const beforeIsToolCall =
      before?.role === "assistant" &&
      Array.isArray((before as { content?: unknown }).content) &&
      (before as { content: Array<{ type?: unknown }> }).content.some((b) => b.type === "toolCall");
    const afterIsToolResult = after?.role === "toolResult";
    expect(beforeIsToolCall && afterIsToolResult).toBe(false);

    // Stronger, global invariant: every toolCall id and its matching toolResult
    // land on the same side of the cut. Content may be a string or a block array;
    // guard both so a string-content message iterates safely.
    const blocksOf = (m: AgentMessage): Array<{ type?: string; id?: string; toolCallId?: string }> => {
      const content = (m as { content?: unknown }).content;
      return Array.isArray(content) ? (content as Array<{ type?: string; id?: string; toolCallId?: string }>) : [];
    };
    const callIdsAcrossCut = new Set<string>();
    for (let i = 0; i < cut; i++) {
      for (const b of blocksOf(messages[i])) if (b.type === "toolCall" && b.id) callIdsAcrossCut.add(b.id);
    }
    for (let i = cut; i < messages.length; i++) {
      for (const b of blocksOf(messages[i])) {
        if (b.type === "text" && b.toolCallId) {
          // A result in `keep` whose call was summarized would be an orphan.
          expect(callIdsAcrossCut.has(b.toolCallId)).toBe(false);
        }
      }
    }
  });
});

describe("compaction plan shape", () => {
  it("both slices are non-empty whenever a plan is returned", () => {
    const messages = Array.from({ length: 10 }, () => [user(400), assistant(400)]).flat();
    const plan = planCompaction(messages, WINDOW, CONFIG);
    expect(plan).not.toBeNull();
    expect(plan!.summarize.length).toBeGreaterThan(0);
    expect(plan!.keep.length).toBeGreaterThan(0);
  });

  it("retains as much recent history as fits the budget, never less than the final turn", () => {
    // Each turn (user+assistant) ≈ 100 tokens; budget 300 → up to 3 turns fit.
    const messages = Array.from({ length: 10 }, () => [user(200), assistant(200)]).flat();
    const plan = planCompaction(messages, WINDOW, CONFIG);
    expect(plan).not.toBeNull();
    const keptTokens = plan!.keep.reduce((sum, m) => sum + estimateTokens(m), 0);
    expect(keptTokens).toBeLessThanOrEqual(KEEP_BUDGET);
    // More than a single message is retained when the budget allows — it doesn't
    // naively keep only the last turn.
    expect(plan!.keep.length).toBeGreaterThan(2);
    // The final message of the conversation is always retained.
    expect(plan!.keep[plan!.keep.length - 1]).toBe(messages[messages.length - 1]);
  });

  it("returns null unless there are at least two user turns to split", () => {
    // Over threshold, but only one user turn → nothing safe to keep separately.
    expect(planCompaction([user(8000), assistant(8000)], 1000, CONFIG)).toBeNull();
  });
});

describe("summary message: no hallucination, stable usage carry", () => {
  const usage: Usage = {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  it("wraps the exact summary text verbatim inside the marker", () => {
    const summary = "The user set up a vault and asked about compaction.";
    const message = buildSummaryMessage(summary, 123);
    expect(message.role).toBe("user");
    expect(isSummaryMessage(message)).toBe(true);
    // The summary text is carried verbatim (trimmed only) — nothing added or rewritten.
    const text = (message as { content: Array<{ type: string; text: string }> }).content[0].text;
    expect(text).toContain("<conversation-summary>");
    expect(text).toContain(summary);
  });

  it("round-trips the folded turns' usage so iterative compaction never loses it", () => {
    const message = buildSummaryMessage("earlier summary", 123, usage);
    expect(isSummaryMessage(message)).toBe(true);
    expect(getCompactedUsage(message)).toEqual(usage);
    // Without a recorded usage, nothing is invented.
    expect(getCompactedUsage(buildSummaryMessage("no usage", 123))).toBeUndefined();
  });

  it("does not flag ordinary user messages as summaries, and only summaries carry usage", () => {
    expect(isSummaryMessage(user(10))).toBe(false);
    expect(isSummaryMessage(assistant(10))).toBe(false);
    expect(getCompactedUsage(user(10))).toBeUndefined();
  });
});
