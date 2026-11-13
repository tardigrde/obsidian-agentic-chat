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
    install: (messages) => {
      events.push(`install:${messages.length}`);
    },
    ...overrides,
  };
}

describe("maybeCompactAgentTranscript", () => {
  it("compacts the active transcript and installs the replacement", async () => {
    const events: string[] = [];

    const compacted = await maybeCompactAgentTranscript(options(events));

    expect(events).toEqual(["get-transcript", "compact:1:100", "install:1"]);
    expect(compacted).toBe(true);
  });

  it("recovers from a failed install once the rewrite is persisted", async () => {
    const events: string[] = [];
    const failures: boolean[] = [];

    const compacted = await maybeCompactAgentTranscript(
      options(events, {
        install: () => {
          events.push("install");
          throw new Error("replace failed");
        },
        recoverAfterReplaceFailure: () => {
          events.push("recover");
          return true;
        },
        onCompactionFailure: (_error, persisted) => failures.push(persisted),
      }),
    );

    expect(events).toEqual(["get-transcript", "compact:1:100", "install", "recover"]);
    expect(failures).toEqual([]);
    expect(compacted).toBe(true);
  });

  it("reports a persisted failure when recovery also fails", async () => {
    const events: string[] = [];
    const failures: boolean[] = [];

    const compacted = await maybeCompactAgentTranscript(
      options(events, {
        install: () => {
          throw new Error("replace failed");
        },
        recoverAfterReplaceFailure: () => false,
        onCompactionFailure: (_error, persisted) => failures.push(persisted),
      }),
    );

    expect(failures).toEqual([true]);
    expect(compacted).toBe(false);
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
