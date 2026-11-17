import { afterEach, describe, expect, it } from "vitest";
import { replayTextTurn } from "../../src/agent/replay-stream";
import { mountChatView, settle, type MountedChatView } from "./support/mount-chat-view";

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
    expect(ui.$(".agentic-chat-step-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(ui.$$(".agentic-chat-subagent-stop")).toHaveLength(0);
    expect(ui.calls()).toBe(0);
  });

  it("history lists the earlier conversation and loading it restores the transcript", async () => {
    ui = await mountChatView({ turns: [replayTextTurn("first answer"), replayTextTurn("second answer")] });
    await ui.send("first conversation");
    await ui.idle();

    ui.$<HTMLButtonElement>('[aria-label="New chat"]')?.click();
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
});
