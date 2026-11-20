import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { replayTextTurn } from "../../src/agent/replay-stream";
import { mountChatView, seedFile, settle, type MountedChatView } from "./support/mount-chat-view";

/** Session reload, history, and new chat through the real ChatView. */

let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
});

function sessionFile(id: string, entries: Array<Record<string, unknown>>): string {
  const now = "2026-11-01T10:00:00.000Z";
  const header = { type: "session", version: 1, id, timestamp: now, cwd: "vault:ui-test" };
  return [header, ...entries.map((entry) => ({ timestamp: now, ...entry }))].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

describe("chat sessions", () => {
  it("reloads a persisted subagent dispatch from stripped details, collapsed with its summary", async () => {
    ui = await mountChatView();
    const path = "sessions/2026-11-01T10-00-00-000Z_aaaa.jsonl";
    await ui.adapter.write(
      path,
      sessionFile("aaaa", [
        { type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
        {
          type: "message",
          id: "m2",
          parentId: "m1",
          message: { role: "assistant", content: [{ type: "toolCall", id: "t-file", name: "subagent", arguments: { agent: "explorer", task: "file task" } }] },
        },
        {
          type: "message",
          id: "m3",
          parentId: "m2",
          message: {
            role: "toolResult",
            toolCallId: "t-file",
            toolName: "subagent",
            content: [{ type: "text", text: "file summary" }],
            details: { kind: "subagent", children: [{ agent: "explorer", task: "file task", status: "done", summary: "file summary", durationMs: 1000 }] },
            isError: false,
          },
        },
        { type: "message", id: "m4", parentId: "m3", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      ]),
    );

    await (ui.view as unknown as { loadSession: (path: string) => Promise<void> }).loadSession(path);
    await settle();
    expect(ui.$(".agentic-chat-user")?.textContent).toContain("hello");
    expect(ui.$(".agentic-chat-subagent pre")?.textContent).toContain("file summary");
    // A replayed turn's activity line starts collapsed.
    expect(ui.$('[data-ac="activity-head"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(ui.$$(".agentic-chat-subagent-stop")).toHaveLength(0);
    expect(ui.calls()).toBe(0);
  });

  it("history lists the earlier conversation and loading it restores the transcript", async () => {
    ui = await mountChatView({ turns: [replayTextTurn("first answer"), replayTextTurn("second answer")] });
    await ui.send("first conversation");
    await ui.idle();

    await ui.view.startNewConversation();
    await settle();
    expect(ui.$$(".agentic-chat-user")).toHaveLength(0);
    expect(ui.$(".agentic-chat-empty")).not.toBeNull();

    await ui.send("second conversation");
    await ui.idle();

    ui.$<HTMLButtonElement>('[aria-label="Conversation history"]')?.click();
    await settle();
    const rowTitles = ui.$$(".agentic-chat-session-title").map((el) => el.textContent);
    expect(rowTitles).toEqual(expect.arrayContaining(["First conversation", "Second conversation"]));

    const firstRow = ui.$$(".agentic-chat-session-row").find((row) => row.textContent?.includes("First conversation"));
    firstRow?.querySelector<HTMLElement>(".agentic-chat-session-main")?.click();
    await settle();
    expect(ui.$(".modal-container")).toBeNull();
    expect(ui.$$(".agentic-chat-user").map((el) => el.textContent)).toEqual([expect.stringContaining("first conversation")]);
    expect(ui.$(".agentic-chat-assistant .agentic-chat-text")?.textContent).toContain("first answer");
  });
  it("U3 #14: sends the active note body to the model once per session, across another note and a history reload", async () => {
    ui = await mountChatView({
      turns: [replayTextTurn("a1"), replayTextTurn("a2"), replayTextTurn("a3"), replayTextTurn("b1"), replayTextTurn("a4")],
    });
    const body = `PLAN-BODY-7f3a\n${"A line of a long working note.\n".repeat(40)}`;
    const plan = await seedFile(ui.app, "Inbox/Plan.md", body);
    const other = await seedFile(ui.app, "Other.md", "other note body");
    const open = async (file: typeof plan) => {
      ui.app.workspace.activeFile = file;
      ui.app.workspace.trigger("file-open", file);
      await settle();
    };
    const userTexts = () =>
      (ui.view as unknown as { service: { getMessages(): AgentMessage[] } }).service.getMessages().flatMap((message) => {
        if (message.role !== "user") return [];
        const content = message.content;
        return [typeof content === "string" ? content : content.map((part) => ("text" in part ? part.text : "")).join("")];
      });

    await open(plan);
    await ui.send("turn one");
    await ui.idle();
    await open(other);
    await ui.send("turn two");
    await ui.idle();
    await open(plan);
    await ui.send("turn three");
    await ui.idle();

    // Load the same conversation again from history (as after a reload).
    await ui.view.startNewConversation();
    await settle();
    await ui.send("other conversation");
    await ui.idle();
    ui.$<HTMLButtonElement>('[aria-label="Conversation history"]')?.click();
    await settle();
    const row = ui.$$(".agentic-chat-session-row").find((el) => el.textContent?.includes("Turn one"));
    row?.querySelector<HTMLElement>(".agentic-chat-session-main")?.click();
    await settle();
    await ui.send("turn four");
    await ui.idle();

    const texts = userTexts();
    expect(texts).toHaveLength(4);
    expect(texts.filter((text) => text.includes(body))).toHaveLength(1);
    expect(texts[3]).toContain('Active note "Inbox/Plan.md" is unchanged');
  });
  it("U3 #13: closing the view mid-turn records the stopped turn, so the session has no turn without an end", async () => {
    ui = await mountChatView({
      turns: [{ ...replayTextTurn("never finishes"), hold: true }],
      waitForRelease: () => new Promise<void>(() => {}),
    });
    await ui.send("a question that gets no answer");
    expect(ui.view.isStreaming()).toBe(true);

    await ui.close();
    await settle();

    const { files } = await ui.adapter.list("sessions");
    const lines = (await ui.adapter.read(files[0])).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const audits = lines.flatMap((line) => (line.type === "action_audit" ? [(line.event as { action?: string }).action] : []));
    const messages = lines.flatMap((line) => (line.type === "message" ? [line.message as { role: string; stopReason?: string }] : []));
    expect(audits.filter((action) => action === "agent_start")).toHaveLength(1);
    expect(audits.filter((action) => action === "agent_end")).toHaveLength(1);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1].stopReason).toBe("aborted");
  });
});
