import { describe, expect, it } from "vitest";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentConversationCompaction } from "../src/agent/conversation-compaction";
import type { AgentCompactionRunResult } from "../src/agent/compaction-runtime";
import { CompactionNotLiveError } from "../src/agent/session-actions";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function agentWith(messages: AgentMessage[]): Agent {
  return { state: { messages, model: { contextWindow: 1_000 } } } as unknown as Agent;
}

interface Harness {
  compaction: AgentConversationCompaction;
  events: string[];
  errors: string[];
  token: { value: number };
}

function harness(
  options: {
    agent?: Agent | null;
    compact?: () => Promise<AgentMessage[] | null>;
    compactWithResult?: () => Promise<AgentCompactionRunResult>;
  } = {},
): Harness {
  const events: string[] = [];
  const errors: string[] = [];
  const token = { value: 1 };
  const agent = options.agent === undefined ? agentWith([userMessage("one"), userMessage("two")]) : options.agent;
  const compaction = new AgentConversationCompaction({
    getAgent: () => agent,
    session: {
      getSessionToken: () => token.value,
      getBinding: () => ({ expectedPath: "sessions/a.jsonl", expectedGeneration: 7 }),
    },
    runtime: {
      compact: async (messages, contextWindow, runOptions) => {
        events.push(`compact:${messages.length}:${contextWindow}:${runOptions?.overheadTokens}`);
        return options.compact ? options.compact() : [userMessage("summary")];
      },
      compactWithResult: async (messages, _contextWindow, runOptions) => {
        events.push(`manual:${messages.length}:${runOptions?.binding?.expectedGeneration}:${runOptions?.force}`);
        return options.compactWithResult
          ? options.compactWithResult()
          : { status: "compacted", messages: [userMessage("summary")] };
      },
    },
    audit: {
      record: async (event) => {
        events.push(`audit:${event.category}:${event.action}`);
      },
    },
    getOverheadTokens: () => 40,
    setError: (message) => errors.push(message),
  });
  return { compaction, events, errors, token };
}

describe("AgentConversationCompaction", () => {
  describe("runAutomatic", () => {
    it("compacts the live conversation with the context overhead the bar counts", async () => {
      const { compaction, events } = harness();

      await expect(compaction.runAutomatic()).resolves.toBeUndefined();

      expect(events).toEqual(["compact:2:1000:40"]);
    });

    it("skips compaction when there is no live conversation", async () => {
      const { compaction, events } = harness({ agent: null });

      await expect(compaction.runAutomatic()).resolves.toBeUndefined();

      expect(events).toEqual([]);
    });

    it("leaves pi's system message out of the transcript it compacts", async () => {
      const system = { role: "system", content: "prompt" } as unknown as AgentMessage;
      const { compaction, events } = harness({ agent: agentWith([system, userMessage("one")]) });

      await compaction.runAutomatic();

      expect(events).toEqual(["compact:1:1000:40"]);
    });

    it("swallows compaction errors so a pending prompt can continue", async () => {
      const { compaction, errors } = harness({
        compact: async () => {
          throw new Error("summary failed");
        },
      });

      await expect(compaction.runAutomatic()).resolves.toBeUndefined();
      expect(errors).toEqual([]);
    });

    it("blocks the pending prompt when the saved transcript was compacted but the live one was not", async () => {
      const { compaction } = harness({
        compact: async () => {
          throw new CompactionNotLiveError(new Error("replace failed"));
        },
      });

      await expect(compaction.runAutomatic()).resolves.toMatch(
        /rewrote the saved session, but the live conversation could not be replaced\. Reload the session/,
      );
    });
  });

  describe("runManual", () => {
    it("binds the pass to the session it read and records one audit pair", async () => {
      const { compaction, events } = harness();

      await expect(compaction.runManual("keep decisions")).resolves.toMatchObject({ compacted: true });

      expect(events).toEqual(["audit:compaction:start", "manual:2:7:true", "audit:compaction:end"]);
    });

    it("does not start a pass when the session changed during the audit write", async () => {
      const { compaction, events, token } = harness();
      const run = compaction.runManual();
      token.value = 2;

      await expect(run).resolves.toEqual({
        compacted: false,
        message: "Nothing compacted. The active session changed before compaction started.",
      });
      expect(events).toEqual(["audit:compaction:start"]);
    });

    it("reports a refused commit as a normal result", async () => {
      const { compaction } = harness({
        compactWithResult: async () => {
          throw new Error("Session changed before the transcript rewrite could start.");
        },
      });

      await expect(compaction.runManual()).resolves.toEqual({
        compacted: false,
        message:
          "Nothing compacted. The active session changed while compacting: " +
          "Session changed before the transcript rewrite could start.",
      });
    });

    it("surfaces a saved-but-not-live compaction as a service error", async () => {
      const { compaction, errors } = harness({
        compactWithResult: async () => {
          throw new CompactionNotLiveError(new Error("replace failed"));
        },
      });

      const result = await compaction.runManual();

      expect(result).toEqual({
        compacted: false,
        message:
          "Compaction rewrote the saved session, but the live conversation could not be replaced: replace failed. " +
          "Reload the session to continue from the compacted transcript.",
      });
      expect(errors).toEqual([result.compacted ? "" : result.message]);
    });

    it("says so when there is no live conversation", async () => {
      const { compaction, events } = harness({ agent: null });

      await expect(compaction.runManual()).resolves.toEqual({
        compacted: false,
        message: "Nothing compacted. No active conversation is loaded.",
      });
      expect(events).toEqual([]);
    });
  });
});
