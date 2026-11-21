import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replayMixedTurn, replayTextTurn, replayToolCallTurn } from "../../src/agent/replay-stream";
import { mountChatView, seedFile, settle, type MountedChatView } from "./support/mount-chat-view";
import { transcriptOrder } from "./support/transcript-order";

/**
 * U4 timeline: the transcript keeps the order of events. Each test states its
 * acceptance sentence and compares the reader's order (transcriptOrder) with
 * it, so it fails when a row lands in the wrong place, not when a class moves.
 */

let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
  vi.useRealTimers();
});

const order = () => transcriptOrder(ui.root);

function rerender(): void {
  const view = ui.view as unknown as { renderTranscript: (m: AgentMessage[]) => void; service: { getMessages: () => AgentMessage[] } };
  view.renderTranscript(view.service.getMessages());
}

describe("U4 #1: one segment per run of steps", () => {
  it("text, tool, text reads in that order, live and after a re-render", async () => {
    ui = await mountChatView({
      turns: [
        replayMixedTurn([{ text: "Let me read it:" }, { id: "r1", name: "read", args: { path: "Notes/a.md" } }]),
        replayMixedTurn([{ text: "Retrying those:" }, { id: "r2", name: "read", args: { path: "Notes/b.md" } }]),
        replayTextTurn("Done reading."),
      ],
    });
    await seedFile(ui.app, "Notes/a.md", "alpha");
    await seedFile(ui.app, "Notes/b.md", "beta");
    await ui.send("read my notes");
    await ui.idle();
    await settle();

    const expected = ["user:read my notes", "text:Let me read it:", "step:Read", "text:Retrying those:", "step:Read", "text:Done reading."];
    expect(order()).toEqual(expected);
    rerender();
    await settle();
    expect(order()).toEqual(expected);
  });

  it("tools before any text stay in one segment above the answer", async () => {
    ui = await mountChatView({
      turns: [
        replayToolCallTurn("r1", "read", { path: "Notes/a.md" }),
        replayToolCallTurn("r2", "read", { path: "Notes/b.md" }),
        replayTextTurn("Both read."),
      ],
    });
    await seedFile(ui.app, "Notes/a.md", "alpha");
    await seedFile(ui.app, "Notes/b.md", "beta");
    await ui.send("read both");
    await ui.idle();
    await settle();
    expect(order()).toEqual(["user:read both", "step:Read", "step:Read", "text:Both read."]);
    expect(ui.$$('[data-ac="activity"]:not(.is-hidden)')).toHaveLength(1);
  });
});

describe("U4 #2/#3: a thought row is a head, not a clipped trace", () => {
  it("folded: bold Thought and its time, no trace text; a click opens the trace", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    ui = await mountChatView();
    ui.emit({ type: "agent_start" });
    ui.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    ui.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "first line\nsecond line" } });
    vi.advanceTimersByTime(2_000);
    ui.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } });
    ui.emit({ type: "agent_end" });
    await settle();

    const thought = ui.$('[data-ac="thought"]');
    const head = thought?.querySelector<HTMLElement>(".agentic-chat-thought-head");
    expect(head?.querySelector(".agentic-chat-thought-label")?.textContent).toBe("Thought");
    expect(head?.querySelector(".agentic-chat-thought-time")?.textContent).toBe("2s");
    // Nothing of the trace is in the folded row, so no line can show through.
    expect(head?.textContent).not.toContain("first line");
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    head?.click();
    expect(thought?.classList.contains("is-expanded")).toBe(true);
    expect(thought?.querySelector(".agentic-chat-thought-text")?.textContent).toBe("first line\nsecond line");
  });
});

describe("U4 #4: a settled approval becomes a line on its step row", () => {
  it("waits outside the block; after Allow the card is gone and the row says Allowed by you", async () => {
    ui = await mountChatView({
      turns: [replayToolCallTurn("call-1", "write", { path: "Notes/new.md", content: "hello" }), replayTextTurn("written")],
    });
    await ui.send("create a note");
    await settle();
    expect(order()).toEqual(["user:create a note", "step:Write", "approval"]);
    const card = ui.$('[data-ac="approval"]');
    expect(card?.closest('[data-ac="activity"]')).toBeNull();

    ui.$<HTMLButtonElement>('[data-ac="approval-allow"]')?.click();
    await ui.idle();
    await settle();
    expect(order()).toEqual(["user:create a note", "step:Write", "text:written"]);
    expect(ui.$$('[data-ac="approval"]')).toHaveLength(0);
    const row = ui.$('[data-ac="step"]');
    expect(row?.getAttribute("data-ac-approval")).toBe("allowed");
    expect(row?.querySelector('[data-ac="step-approval"]')?.textContent).toBe("Allowed by you");
    // The record must be readable on a folded row: the step detail is display:none until opened.
    expect(row?.classList.contains("is-open")).toBe(false);
    expect(row?.querySelector('[data-ac="step-approval"]')?.closest(".agentic-chat-step-detail")).toBeNull();
  });

  it("a deny records Denied by you on the row", async () => {
    ui = await mountChatView({
      turns: [replayToolCallTurn("call-1", "write", { path: "Notes/new.md", content: "hello" }), replayTextTurn("ok, not written")],
    });
    await ui.send("create a note");
    await settle();
    const deny = ui.$<HTMLButtonElement>('[data-ac="approval-deny"]');
    deny?.click();
    deny?.click();
    await ui.idle();
    await settle();
    expect(ui.$$('[data-ac="approval"]')).toHaveLength(0);
    expect(ui.$('[data-ac="step-approval"]')?.textContent).toBe("Denied by you");
  });
});

describe("U4 #5: subagents get their own section", () => {
  it("one collapsed section per segment, one row per child with Stop while it runs", async () => {
    ui = await mountChatView();
    ui.emit({ type: "agent_start" });
    ui.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    ui.emit({ type: "tool_execution_start", toolCallId: "s1", toolName: "subagent", args: { agent: "explorer", task: "map the vault" } });
    const running = [{ agent: "explorer", task: "map the vault", status: "running", stopId: "stop-1", transcript: [{ type: "text", text: "looking" }] }];
    ui.emit({ type: "tool_execution_update", toolCallId: "s1", partialResult: { details: { kind: "subagent", children: running } } });
    await settle();

    const block = ui.$('[data-ac="subagents"]');
    expect(block).not.toBeNull();
    expect(block?.closest('[data-ac="activity"]')).toBeNull();
    expect(block?.querySelector(".agentic-chat-subagent-block-summary")?.textContent).toBe("Subagents · 1 running");
    expect(block?.querySelector('[data-ac="subagents-head"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(block?.querySelectorAll('[data-ac="subagent-row"]')).toHaveLength(1);
    expect(block?.querySelector(".agentic-chat-subagent-stop")).not.toBeNull();
    expect(order()).toEqual(["step:Subagent", "subagents"]);

    const done = [{ agent: "explorer", task: "map the vault", status: "done", summary: "found 3 notes", durationMs: 4_000, usage: { input: 1, output: 1, totalTokens: 2, costUsd: 0.012 } }];
    ui.emit({ type: "tool_execution_end", toolCallId: "s1", isError: false, result: { content: [{ type: "text", text: "ok" }], details: { kind: "subagent", children: done } } });
    ui.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    ui.emit({ type: "agent_end" });
    await settle();
    expect(block?.querySelector(".agentic-chat-subagent-block-summary")?.textContent).toBe("Subagents · 1 done");
    expect(block?.classList.contains("is-open")).toBe(false);
    expect(block?.querySelector(".agentic-chat-subagent-stop")).toBeNull();
    const row = block?.querySelector<HTMLDetailsElement>('[data-ac="subagent-row"]');
    expect(row?.querySelector(".agentic-chat-subagent-time")?.textContent).toBe("4s");
    expect(row?.querySelector(".agentic-chat-subagent-meta")?.textContent).toBe("$0.01");
    expect(row?.querySelector(".agentic-chat-subagent-log")?.textContent).toContain("found 3 notes");
  });
});
