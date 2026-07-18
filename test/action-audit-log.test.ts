import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  AgentActionAuditRecorder,
  buildApprovalAuditEvent,
  buildCheckpointAuditEvent,
  diffSummaryForContent,
  filterActionAuditEvents,
  redactAuditResult,
  redactAuditValue,
  type ActionAuditEvent,
} from "../src/agent/action-audit-log";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { parseSessionEntries, type SessionEntry } from "../src/session/jsonl";
import { MemoryAdapter } from "./helpers/memory-adapter";

const DEFAULTS = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" as const };
const FIXED_NOW = Date.UTC(2026, 5, 26, 9, 0, 0);

function auditEntries(adapter: MemoryAdapter, path: string): Extract<SessionEntry, { type: "action_audit" }>[] {
  return parseSessionEntries(adapter.files.get(path) ?? "").filter(
    (entry): entry is Extract<SessionEntry, { type: "action_audit" }> => entry.type === "action_audit",
  );
}

describe("AgentActionAuditRecorder", () => {
  it("persists turn and tool-call audit events into the active session", async () => {
    const adapter = new MemoryAdapter();
    const manager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    const info = await manager.createSession(DEFAULTS);
    const recorder = new AgentActionAuditRecorder({
      sessionManager: manager,
      getContext: () => ({
        provider: "openrouter",
        modelId: "openai/gpt-test",
        thinkingLevel: "high",
        now: () => FIXED_NOW,
      }),
    });

    await recorder.recordAgentEvent({ type: "agent_start" });
    await recorder.recordAgentEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "write",
      args: {
        path: "Notes/A.md",
        content: "secret body should be summarized",
        apiKey: "live-secret",
      },
    } as AgentEvent);
    await recorder.recordAgentEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "write",
      result: { ok: true, token: "result-secret" },
      isError: false,
    });

    const events = auditEntries(adapter, info.path).map((entry) => entry.event);
    expect(events).toEqual([
      expect.objectContaining({
        category: "turn",
        action: "agent_start",
        provider: "openrouter",
        modelId: "openai/gpt-test",
        thinkingLevel: "high",
      }),
      expect.objectContaining({
        category: "tool_call",
        action: "start",
        toolCallId: "call-1",
        toolName: "write",
        touchedFiles: ["Notes/A.md"],
        args: { path: "Notes/A.md", content: "[content 32 chars]", apiKey: "[redacted]" },
        diff: expect.objectContaining({ kind: "write", path: "Notes/A.md", afterCharLength: 32 }),
      }),
      expect.objectContaining({
        category: "tool_call",
        action: "end",
        result: { ok: true, token: "[redacted]" },
        isError: false,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("live-secret");
    expect(JSON.stringify(events)).not.toContain("secret body should be summarized");
  });

  it("redacts secret fields, summarizes content fields, and truncates large values", () => {
    const redacted = redactAuditValue({
      authorization: "Bearer secret",
      nested: { refreshToken: "secret-token" },
      content: "note body",
      safe: "x".repeat(505),
    });

    expect(redacted).toEqual({
      authorization: "[redacted]",
      nested: { refreshToken: "[redacted]" },
      content: "[content 9 chars]",
      safe: `${"x".repeat(500)}...[truncated 5 chars]`,
    });
  });

  it("filters audit events by category, decision, touched path, and egress kind", () => {
    const events: ActionAuditEvent[] = [
      buildApprovalAuditEvent({
        decision: "approved",
        toolCallId: "call-write",
        toolName: "write",
        args: { path: "Notes/A.md", content: "body" },
      }),
      buildApprovalAuditEvent({
        decision: "denied",
        toolCallId: "call-mcp",
        toolName: "mcp__docs__search",
        args: { query: "oauth" },
      }),
      buildCheckpointAuditEvent({
        toolCallId: "call-write",
        toolName: "write",
        undo: { kind: "content", path: "Notes/A.md", before: "old" },
      }),
      buildApprovalAuditEvent({
        decision: "auto-approved",
        toolCallId: "call-properties",
        toolName: "set_properties",
        args: { path: "Notes/B.md", properties: { status: "done", oldToken: "secret" } },
      }),
    ];

    expect(filterActionAuditEvents(events, { category: "approval" })).toHaveLength(3);
    expect(filterActionAuditEvents(events, { decision: "denied" })).toEqual([events[1]]);
    expect(filterActionAuditEvents(events, { egressKind: "mcp" })).toEqual([events[1]]);
    expect(filterActionAuditEvents(events, { touchedPath: "Notes/A.md" })).toEqual([events[0], events[2]]);
    expect(events[3]).toMatchObject({
      diff: { kind: "edit", path: "Notes/B.md", editCount: 2 },
      args: { properties: { oldToken: "[redacted]" } },
    });
  });

  it("summarizes content diffs without storing the full diff for large changes", () => {
    expect(diffSummaryForContent("Notes/A.md", "old\n", "old\nnew\n")).toMatchObject({
      kind: "edit",
      path: "Notes/A.md",
      stat: { added: 1, removed: 0 },
    });

    const before = Array.from({ length: 600 }, (_unused, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 600 }, (_unused, index) => `new ${index}`).join("\n");
    const large = diffSummaryForContent("Notes/Large.md", before, after);
    expect(large).toMatchObject({
      kind: "edit",
      path: "Notes/Large.md",
      lineDiffOmitted: true,
      beforeCharLength: before.length,
      afterCharLength: after.length,
    });
  });

  it("B5: redactAuditResult preserves tool result content instead of summarizing it", () => {
    const result = {
      content: [
        { type: "text", text: "Applied 2 edits to Notes/A.md." },
        { type: "text", text: "Edit 1: replaced old text" },
      ],
      ok: true,
    };
    const redacted = redactAuditResult(result) as { content: unknown[]; ok: boolean };
    expect(redacted.ok).toBe(true);
    expect(redacted.content).toHaveLength(2);
    expect(redacted.content[0]).toEqual({ type: "text", text: "Applied 2 edits to Notes/A.md." });
  });

  it("B5: redactAuditValue still summarizes content (old behavior for args)", () => {
    const args = { path: "Notes/A.md", content: "some body text" };
    const redacted = redactAuditValue(args) as { path: string; content: string };
    expect(redacted.path).toBe("Notes/A.md");
    expect(redacted.content).toBe("[content 14 chars]");
  });
});
