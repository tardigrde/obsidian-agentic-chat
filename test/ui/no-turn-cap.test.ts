import { afterEach, describe, expect, it, vi } from "vitest";
import { replayTextTurn, replayToolCallTurn, type ReplayTurn } from "../../src/agent/replay-stream";
import { mountChatView, seedFile, settle, type MountedChatView } from "./support/mount-chat-view";

/**
 * U4 decision (owner, 2026-11-21): no turn caps. A long run ends when the
 * model answers, or on Stop, the loop guard, or the spend cap. The real view
 * and AgentService run here; only the model is scripted.
 */

let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
});

/** `count` read calls on different notes (no identical batch, so the loop guard stays quiet). */
function reads(prefix: string, count: number): ReplayTurn[] {
  return Array.from({ length: count }, (_, index) => replayToolCallTurn(`${prefix}${index}`, "read", { path: `Long/N${index % 5}.md`, offset: index }));
}

async function seedNotes(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await seedFile(ui.app, `Long/N${index}.md`, `note ${index}`);
}

describe("no turn caps (U4)", () => {
  it("the parent runs past the old 25-turn cap and answers", async () => {
    ui = await mountChatView({ turns: [...reads("p", 30), replayTextTurn("PARENT-DONE after 30 reads.")] });
    await seedNotes();
    await ui.send("read a lot");
    await ui.idle();
    await settle();
    expect(ui.calls()).toBe(31);
    expect(ui.root.textContent).toContain("PARENT-DONE after 30 reads.");
    expect(ui.root.textContent).not.toMatch(/Turn cap/);
  });

  it("a subagent runs past the old 10-turn child cap and returns its report", async () => {
    ui = await mountChatView({
      turns: [
        replayToolCallTurn("dispatch", "subagent", { agent: "explorer", task: "read all five notes twice" }, { caller: "parent" }),
        ...reads("c", 12).map((turn) => ({ ...turn, caller: "child" as const })),
        replayTextTurn("CHILD-REPORT read 12 times, all notes present.", { caller: "child" }),
        replayTextTurn("PARENT-FREE the explorer runs.", { caller: "parent" }),
        replayTextTurn("PARENT-END the explorer is done.", { caller: "parent" }),
      ],
    });
    await seedNotes();
    await ui.send("delegate");
    await vi.waitFor(() => expect(ui.root.textContent).toContain("CHILD-REPORT read 12 times"), { timeout: 3_000 });
    await ui.idle();
    await settle();
    // 1 dispatch + 13 child calls + 1 or 2 parent calls (the report steers in, or starts a turn).
    expect(ui.calls()).toBeGreaterThanOrEqual(15);
    expect(ui.root.textContent).toContain("CHILD-REPORT read 12 times");
    expect(ui.root.textContent).not.toMatch(/Turn cap/);
  });

  it("the spend cap stops a running subagent mid-run, not only after the dispatch returns (U4 #9)", async () => {
    const paid = { usage: { input: 10, output: 10, totalTokens: 20, cost: { total: 0.002 } } };
    const childReads = Array.from({ length: 12 }, (_, index) =>
      replayToolCallTurn(`s${index}`, "read", { path: `Long/N${index % 5}.md`, offset: index }, paid),
    );
    ui = await mountChatView({
      turns: [
        replayToolCallTurn("dispatch", "subagent", { agent: "explorer", task: "read everything" }),
        ...childReads,
        replayTextTurn("CHILD-REPORT should never be reached.", paid),
        replayTextTurn("PARENT-END should never be reached."),
      ],
      settings: { notifications: { enabled: true, costAlertUsd: 0, costCapUsd: 0.005 } },
    });
    await seedNotes();
    await ui.send("delegate and spend");
    await ui.idle();
    await settle();
    // 0.002 per child call: the third child call crosses $0.005 and the run
    // stops there; a call already in flight may still land (main: all 12 ran).
    expect(ui.calls()).toBeLessThanOrEqual(6);
    expect(ui.root.textContent).not.toContain("PARENT-END");
    expect(ui.root.textContent).toMatch(/spend cap/i);
  });
});
