import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { maybeCompactAgentTranscript, type AgentCompactionOrchestratorOptions } from "../src/agent/compaction-orchestrator";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function options(
  events: string[],
  overrides: Partial<AgentCompactionOrchestratorOptions> = {},
): AgentCompactionOrchestratorOptions {
  const original = [userMessage("old")];
  const compacted = [userMessage("summary")];
  return {
    getTranscript: () => {
      events.push("get-transcript");
      return { messages: original, contextWindow: 100 };
    },
    compact: async (messages, contextWindow) => {
      events.push(`compact:${messages.length}:${contextWindow}`);
      return compacted;
    },
    markPersistedMessages: (messages) => {
      events.push(`mark:${messages.length}`);
    },
    replaceAgent: (messages) => {
      events.push(`replace:${messages.length}`);
    },
    refreshActiveSessionInfo: () => {
      events.push("refresh-session");
    },
    notifyChange: () => {
      events.push("notify");
    },
    ...overrides,
  };
}

describe("maybeCompactAgentTranscript", () => {
  it("compacts the active transcript and applies the replacement side effects in order", async () => {
    const events: string[] = [];

    const compacted = await maybeCompactAgentTranscript(options(events));

    expect(events).toEqual([
      "get-transcript",
      "compact:1:100",
      "mark:1",
      "replace:1",
      "refresh-session",
      "notify",
    ]);
    expect(compacted).toBe(true);
  });

  it("skips compaction when there is no active transcript", async () => {
    const events: string[] = [];

    const compacted = await maybeCompactAgentTranscript(
      options(events, {
        getTranscript: () => {
          events.push("get-transcript");
          return null;
        },
      }),
    );

    expect(events).toEqual(["get-transcript"]);
    expect(compacted).toBe(false);
  });

  it("does not apply side effects when compaction returns no replacement", async () => {
    const events: string[] = [];

    const compacted = await maybeCompactAgentTranscript(
      options(events, {
        compact: async () => {
          events.push("compact");
          return null;
        },
      }),
    );

    expect(events).toEqual(["get-transcript", "compact"]);
    expect(compacted).toBe(false);
  });

  it("swallows compaction errors so a pending prompt can continue", async () => {
    const events: string[] = [];

    const compacted = await maybeCompactAgentTranscript(
      options(events, {
        compact: async () => {
          events.push("compact");
          throw new Error("summary failed");
        },
      }),
    );

    expect(events).toEqual(["get-transcript", "compact"]);
    expect(compacted).toBe(false);
  });
});
