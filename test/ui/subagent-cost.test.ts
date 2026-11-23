import { afterEach, describe, expect, it, vi } from "vitest";
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
        replayToolCallTurn("dispatch", "subagent", { agent: "explorer", task: "read the note" }, { ...paid(0.001), caller: "parent" }),
        replayToolCallTurn("c1", "read", { path: "Cost/Note.md" }, { ...paid(0.002), caller: "child" }),
        replayTextTurn("CHILD-REPORT the note is short.", { ...paid(0.002), caller: "child" }),
        replayTextTurn("PARENT-END done.", { ...paid(0.001), caller: "parent" }),
        replayTextTurn("PARENT-NOTED report read.", { ...paid(0), caller: "parent" }),
      ],
    });
    await seedFile(ui.app, "Cost/Note.md", "short note");
    await ui.send("delegate");
    await vi.waitFor(() => expect(ui.$('[data-ac="subagent-event"]')).not.toBeNull(), { timeout: 3_000 });
    await ui.idle();
    await settle();

    // Parent 0.002 + child 0.004 in the composer-bar total (U5 #1: the child's part comes with its report).
    expect(ui.$('[data-ac="session-cost"]')?.textContent).toBe("$0.0060");

    // A reload: the live child accounting is gone; the transcript still carries it.
    const view = ui.view as unknown as { service: ServiceLike; renderTranscript: (messages: unknown[]) => void };
    view.service.sessionState.reset();
    expect(view.service.getSessionUsage().cost.total).toBeCloseTo(0.006);
    view.renderTranscript(view.service.getMessages());
    await settle();
    // After a reload the child's row still shows its own cost, from the report.
    expect(ui.$('[data-ac="step"].is-subagent .agentic-chat-step-time')?.textContent).toContain("$0.0040");
  });
});
