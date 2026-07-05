import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  createSessionHeader,
  getLatestPlanTrackerState,
  getLastLeafId,
  parseSessionEntries,
  serializeSessionEntries,
  type SessionEntry,
} from "../src/session/jsonl";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function messageText(message: AgentMessage): string {
  return (message as unknown as { content: [{ text: string }] }).content[0].text;
}

describe("session jsonl", () => {
  it("round-trips entries through serialize/parse and skips blank lines", () => {
    const entries: SessionEntry[] = [
      createSessionHeader("sid", "vault", "2026-06-13T00:00:00.000Z"),
      { type: "message", id: "m1", parentId: null, timestamp: "t", message: userMessage("hi") },
    ];
    const serialized = `${serializeSessionEntries(entries)}\n\n`;
    expect(parseSessionEntries(serialized)).toEqual(entries);
  });

  it("walks the parent chain to reconstruct the active branch", () => {
    const entries: SessionEntry[] = [
      createSessionHeader("sid", "vault"),
      { type: "model_change", id: "c1", parentId: null, timestamp: "t", provider: "openrouter", modelId: "x/y" },
      { type: "thinking_level_change", id: "c2", parentId: "c1", timestamp: "t", thinkingLevel: "high" },
      { type: "message", id: "m1", parentId: "c2", timestamp: "t", message: userMessage("first") },
      { type: "message", id: "m2", parentId: "m1", timestamp: "t", message: userMessage("second") },
    ];
    const context = buildSessionContext(entries, "m2");
    expect(context.messages).toHaveLength(2);
    expect(context.model).toEqual({ provider: "openrouter", modelId: "x/y" });
    expect(context.thinkingLevel).toBe("high");
    expect(getLastLeafId(entries)).toBe("m2");
  });

  it("ignores action audit entries when reconstructing replay context", () => {
    const entries: SessionEntry[] = [
      createSessionHeader("sid", "vault"),
      { type: "model_change", id: "c1", parentId: null, timestamp: "t", provider: "openrouter", modelId: "x/y" },
      { type: "message", id: "m1", parentId: "c1", timestamp: "t", message: userMessage("first") },
      {
        type: "action_audit",
        id: "a1",
        parentId: "m1",
        timestamp: "2026-06-26T09:00:00.000Z",
        event: {
          category: "tool_call",
          action: "start",
          timestamp: "2026-06-26T09:00:00.000Z",
          toolCallId: "call-1",
          toolName: "write",
          touchedFiles: ["Notes/A.md"],
        },
      },
      { type: "message", id: "m2", parentId: "a1", timestamp: "t", message: userMessage("second") },
      {
        type: "action_audit",
        id: "a2",
        parentId: "m2",
        timestamp: "2026-06-26T09:00:01.000Z",
        event: {
          category: "approval",
          action: "decision",
          timestamp: "2026-06-26T09:00:01.000Z",
          decision: "approved",
          toolCallId: "call-1",
          toolName: "write",
          touchedFiles: ["Notes/A.md"],
        },
      },
      {
        type: "file_checkpoint",
        id: "fc1",
        parentId: "a2",
        timestamp: "2026-06-26T09:00:02.000Z",
        checkpoint: {
          version: 1,
          id: "checkpoint-call-1",
          toolCallId: "call-1",
          toolName: "write",
          createdAt: "2026-06-26T09:00:02.000Z",
          entries: [{ kind: "content", path: "Notes/A.md", before: "old" }],
        },
      },
    ];

    const context = buildSessionContext(entries);

    expect(getLastLeafId(entries)).toBe("fc1");
    expect(context.messages.map((message) => (message as unknown as { content: [{ text: string }] }).content[0].text))
      .toEqual(["first", "second"]);
    expect(context.model).toEqual({ provider: "openrouter", modelId: "x/y" });
  });

  it("keeps plan tracker entries out of replayed messages while exposing latest state", () => {
    const entries: SessionEntry[] = [
      createSessionHeader("sid", "vault"),
      { type: "message", id: "m1", parentId: null, timestamp: "t", message: userMessage("first") },
      {
        type: "plan_tracker",
        id: "p1",
        parentId: "m1",
        timestamp: "2026-06-26T12:00:00.000Z",
        state: {
          version: 1,
          title: "Goal",
          updatedAt: "2026-06-26T12:00:00.000Z",
          items: [
            {
              id: "1",
              title: "Checkpoint",
              status: "done",
              testStatus: "passed",
              checkpointCommit: "abc123",
              updatedAt: "2026-06-26T12:00:00.000Z",
            },
          ],
        },
      },
      { type: "message", id: "m2", parentId: "p1", timestamp: "t", message: userMessage("second") },
    ];

    expect(buildSessionContext(entries).messages.map((message) => messageText(message))).toEqual(["first", "second"]);
    expect(getLatestPlanTrackerState(entries)).toMatchObject({
      title: "Goal",
      items: [{ id: "1", title: "Checkpoint", status: "done", testStatus: "passed" }],
    });
  });

  it("returns an empty branch for a null leaf", () => {
    const entries: SessionEntry[] = [createSessionHeader("sid", "vault")];
    expect(buildSessionContext(entries, null).messages).toHaveLength(0);
    expect(getLastLeafId(entries)).toBeNull();
  });
});
