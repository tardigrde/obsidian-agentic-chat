import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { exportFileName, hasExportableTurns, sessionToMarkdown } from "../src/session/export";
import type { SessionInfo } from "../src/session/session-manager";

const info: SessionInfo = {
  id: "s1",
  path: "sessions/x.jsonl",
  createdAt: "2026-06-16T10:00:00.000Z",
  updatedAt: "2026-06-16T11:00:00.000Z",
  name: "Trip planning",
  messageCount: 2,
  firstMessage: "Help me pack",
};

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function assistant(text: string, calls: Array<{ id: string; name: string }> = []): AgentMessage {
  return {
    role: "assistant",
    content: [...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })), { type: "text", text }],
  } as unknown as AgentMessage;
}

function toolResult(id: string, isError: boolean): AgentMessage {
  return { role: "toolResult", toolCallId: id, isError, content: [{ type: "text", text: "result" }] } as unknown as AgentMessage;
}

describe("session export", () => {
  it("renders frontmatter, user and assistant turns", () => {
    const md = sessionToMarkdown([user("Help me pack"), assistant("Sure, here is a list.")], info);
    expect(md).toContain('title: "Trip planning"');
    expect(md).toContain("created: 2026-06-16T10:00:00.000Z");
    expect(md).toContain("source: agentic-chat");
    expect(md).toContain("# Trip planning");
    expect(md).toContain("## You\n\nHelp me pack");
    expect(md).toContain("## Assistant\n\nSure, here is a list.");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("strips the attachment context preamble from user turns", () => {
    const md = sessionToMarkdown([user("<context>\nattached stuff\n</context>\n\nWhat is this?")], info);
    expect(md).toContain("## You\n\nWhat is this?");
    expect(md).not.toContain("attached stuff");
  });

  it("lists tool calls and flags errored ones", () => {
    const md = sessionToMarkdown(
      [assistant("Done.", [{ id: "t1", name: "write" }, { id: "t2", name: "read" }]), toolResult("t1", true), toolResult("t2", false)],
      info,
    );
    expect(md).toContain("- `write` (error)");
    expect(md).toContain("- `read`");
    expect(md).not.toContain("- `read` (error)");
  });

  it("detects whether there's anything to export", () => {
    expect(hasExportableTurns([])).toBe(false);
    expect(hasExportableTurns([user("hi")])).toBe(true);
  });

  it("builds a sanitized, timestamped filename in UTC", () => {
    const now = Date.UTC(2026, 5, 16, 11, 0, 0); // 2026-06-16T11:00:00Z
    expect(exportFileName(info, now)).toBe("Trip planning 2026-06-16 11-00-00.md");
    const messy: SessionInfo = { ...info, name: "a/b:c?d" };
    expect(exportFileName(messy, now)).toBe("a b c d 2026-06-16 11-00-00.md");
    const unnamed: SessionInfo = { ...info, name: undefined };
    expect(exportFileName(unnamed, now)).toBe("Agentic chat conversation 2026-06-16 11-00-00.md");
  });
});
