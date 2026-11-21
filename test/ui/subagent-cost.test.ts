import { afterEach, describe, expect, it } from "vitest";
import { replayTextTurn, replayToolCallTurn } from "../../src/agent/replay-stream";
import { mountChatView, seedFile, settle, type MountedChatView } from "./support/mount-chat-view";

/**
 * U4 #8: a subagent's cost belongs to the session. Before, child usage only
 * reached `/usage` live, the turn footer was parent-only, and a reload lost it.
 */

let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
});

const paid = (cost: number) => ({ usage: { input: 10, output: 10, totalTokens: 20, cost: { total: cost } } });

interface ServiceLike {
  getSessionUsage: () => { cost: { total: number } };
  getMessages: () => unknown[];
  sessionState: { reset: () => void };
}

describe("subagent cost (U4 #8)", () => {
  it("counts in the turn footer and the composer-bar total, and survives a reload", async () => {
    ui = await mountChatView({
      turns: [
        replayToolCallTurn("dispatch", "subagent", { agent: "explorer", task: "read the note" }, paid(0.001)),
        replayToolCallTurn("c1", "read", { path: "Cost/Note.md" }, paid(0.002)),
        replayTextTurn("CHILD-REPORT the note is short.", paid(0.002)),
        replayTextTurn("PARENT-END done.", paid(0.001)),
      ],
    });
    await seedFile(ui.app, "Cost/Note.md", "short note");
    await ui.send("delegate");
    await ui.idle();
    await settle();

    // Parent 0.002 + child 0.004.
    expect(ui.$('[data-ac="session-cost"]')?.textContent).toBe("$0.0060");
    expect(ui.$$('[data-ac="turn-meta"]').at(-1)?.textContent).toContain("$0.006");

    // A reload: the live child accounting is gone; the transcript still carries it.
    const view = ui.view as unknown as { service: ServiceLike; renderTranscript: (messages: unknown[]) => void };
    view.service.sessionState.reset();
    expect(view.service.getSessionUsage().cost.total).toBeCloseTo(0.006);
    view.renderTranscript(view.service.getMessages());
    await settle();
    expect(ui.$$('[data-ac="turn-meta"]').at(-1)?.textContent).toContain("$0.006");
  });
});
