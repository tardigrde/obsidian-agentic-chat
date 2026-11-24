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

describe("U5 #2, #3: a subagent is one row in the activity block", () => {
  it("no separate section; the row runs in event order; its report comes later as an event", async () => {
    ui = await mountChatView();
    ui.emit({ type: "agent_start" });
    ui.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    ui.emit({ type: "tool_execution_start", toolCallId: "s1", toolName: "subagent", args: { agent: "explorer", task: "map the vault" } });
    const running = [{ agent: "explorer", task: "map the vault", status: "running", childId: "sa-1", stopId: "sa-1", transcript: [{ type: "text", text: "looking" }] }];
    ui.emit({ type: "tool_execution_end", toolCallId: "s1", isError: false, result: { content: [{ type: "text", text: "Started" }], details: { kind: "subagent", children: running } } });
    ui.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    ui.emit({ type: "agent_end" });
    await settle();

    expect(ui.$(".agentic-chat-subagent-block")).toBeNull();
    const row = ui.$('[data-ac="step"].is-subagent');
    expect(row?.closest('[data-ac="activity"]')).not.toBeNull();
    expect(row?.classList.contains("is-child-running")).toBe(true);
    expect(order()).toEqual(["step:Subagent"]);

    ui.emit({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: '<subagent_report id="sa-1" agent="explorer" status="done" call="s1">\nfound 3 notes\n</subagent_report>' }],
      },
    });
    await settle();
    expect(order()).toEqual(["step:Subagent", "report:explorer"]);
  });
});
