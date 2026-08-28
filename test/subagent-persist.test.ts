/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { persistedSnapshot, pendingSubagentErrorDetails, clearPendingSubagentErrorDetails, type SubagentChildStatus } from "../src/tools/subagent-tool";
import { AgentToolCallController } from "../src/agent/tool-call-controller";
import type { App } from "obsidian";

function fakeApp(): App {
  return { vault: { getAbstractFileByPath: () => null } } as unknown as App;
}

describe("persistedSnapshot", () => {
  it("strips transcript and stopId but keeps summary/duration/usage", () => {
    const child: SubagentChildStatus = {
      agent: "explorer",
      task: "map vault",
      status: "done",
      summary: "found 3 notes Bearer sk-1234567890abcdef",
      stopId: "call-1",
      transcript: [{ type: "text", text: "hello" }],
      durationMs: 1234,
      usage: { input: 100, output: 200, totalTokens: 300, costUsd: 0.01 },
    };
    const persisted = persistedSnapshot([child]);
    expect(persisted.children[0].transcript).toBeUndefined();
    expect(persisted.children[0].stopId).toBeUndefined();
    expect(persisted.children[0].summary).toContain("[redacted]");
    expect(persisted.children[0].durationMs).toBe(1234);
    expect(persisted.children[0].usage).toEqual({ input: 100, output: 200, totalTokens: 300, costUsd: 0.01 });
  });

  it("redacts high-entropy and task/agent", () => {
    const child: SubagentChildStatus = {
      agent: "explorer",
      task: "do thing sk-or-v1-abc123def456ghi789jkl",
      status: "done",
      summary: "result with Bearer abc.def.ghi",
    };
    const persisted = persistedSnapshot([child]);
    expect(persisted.children[0].task).toContain("[redacted]");
    expect(persisted.children[0].summary).toContain("[redacted]");
  });

  it("is idempotent on already stripped input", () => {
    const stripped: SubagentChildStatus = { agent: "a", task: "t", status: "done", summary: "s" };
    const persisted = persistedSnapshot([stripped]);
    expect(persisted.children[0]).toEqual(stripped);
    const double = persistedSnapshot(persisted.children);
    expect(double.children[0]).toEqual(stripped);
  });
});

describe("AgentToolCallController.afterToolCall subagent stripping", () => {
  it("strips transcript/stopId on success", async () => {
    const controller = new AgentToolCallController({
      app: fakeApp(),
      getSettings: () => ({ mode: "safe", approval: { mutating: "allow", perTool: {}, workingDirs: [] }, mcp: { servers: [] } } as any),
      confirmToolCall: async () => ({ approved: true, remember: false }),
      getTools: () => [],
      getProfiles: () => [],
      onUndoApplied: () => {},
    });
    const details = {
      kind: "subagent",
      children: [{ agent: "explorer", task: "t", status: "done", summary: "ok", stopId: "x", transcript: [{ type: "text", text: "hi" }] }],
    };
    const result = await controller.afterToolCall({
      toolCall: { id: "call-ok", name: "subagent" },
      isError: false,
      result: { details } as any,
    });
    expect(result?.details).toEqual({
      kind: "subagent",
      children: [{ agent: "explorer", task: "t", status: "done", summary: "ok" }],
    });
    // original not mutated? persistedSnapshot creates new
    expect((result?.details as any).children[0].transcript).toBeUndefined();
  });

  it("injects pending error details", async () => {
    const controller = new AgentToolCallController({
      app: fakeApp(),
      getSettings: () => ({ mode: "safe", approval: { mutating: "allow", perTool: {}, workingDirs: [] }, mcp: { servers: [] } } as any),
      confirmToolCall: async () => ({ approved: true, remember: false }),
      getTools: () => [],
      getProfiles: () => [],
      onUndoApplied: () => {},
    });
    const persisted = { kind: "subagent", children: [{ agent: "explorer", task: "bad", status: "error", summary: "disk full" }] };
    pendingSubagentErrorDetails.set("call-err", persisted as any);
    const result = await controller.afterToolCall({
      toolCall: { id: "call-err", name: "subagent" },
      isError: true,
      result: { details: {} } as any,
    });
    expect(result?.details).toEqual(persisted);
    expect(pendingSubagentErrorDetails.has("call-err")).toBe(false);
  });

  it("clears pending on clearSessionState", async () => {
    const controller = new AgentToolCallController({
      app: fakeApp(),
      getSettings: () => ({ mode: "safe", approval: { mutating: "allow", perTool: {}, workingDirs: [] }, mcp: { servers: [] } } as any),
      confirmToolCall: async () => ({ approved: true, remember: false }),
      getTools: () => [],
      getProfiles: () => [],
      onUndoApplied: () => {},
    });
    pendingSubagentErrorDetails.set("leak", { kind: "subagent", children: [] } as any);
    controller.clearSessionState();
    expect(pendingSubagentErrorDetails.has("leak")).toBe(false);
    clearPendingSubagentErrorDetails();
  });

  it("passes through non-subagent", async () => {
    const controller = new AgentToolCallController({
      app: fakeApp(),
      getSettings: () => ({ mode: "safe", approval: { mutating: "allow", perTool: {}, workingDirs: [] }, mcp: { servers: [] } } as any),
      confirmToolCall: async () => ({ approved: true, remember: false }),
      getTools: () => [],
      getProfiles: () => [],
      onUndoApplied: () => {},
    });
    const result = await controller.afterToolCall({
      toolCall: { id: "other", name: "read" },
      isError: false,
      result: { details: { foo: "bar" } } as any,
    });
    expect(result).toBeUndefined();
  });
});
