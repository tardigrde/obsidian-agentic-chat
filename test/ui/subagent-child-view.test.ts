import { describe, expect, it } from "vitest";
import { SubagentChildView } from "../../src/ui/subagent-tree";
import { settle } from "./support/mount-chat-view";

/**
 * U5 #12: after a reload a child's live timeline is gone; the row loads the
 * stored one (an artifact) instead of showing only the report.
 */
describe("SubagentChildView: the stored timeline after a reload (U5 #12)", () => {
  function slots() {
    const row = createDiv();
    const head = row.createDiv();
    const icon = head.createSpan();
    const time = head.createSpan();
    const detail = row.createDiv();
    return { row, head, icon, time, detail };
  }

  it("loads the stored timeline once for a settled child with no live transcript", async () => {
    const requested: string[] = [];
    const view = new SubagentChildView(slots(), {
      live: false,
      loadTimeline: async (id) => {
        requested.push(id);
        return [
          { type: "tool", name: "read", status: "start", args: { path: "Inbox/A.md" } },
          { type: "tool", name: "read", status: "end" },
          { type: "text", text: "Two gaps." },
        ];
      },
    });
    const child = { agent: "explorer", task: "t", status: "done" as const, summary: "report", timelineArtifactId: "art-9" };
    view.update(child);
    view.update(child);
    await settle();
    expect(requested).toEqual(["art-9"]);
    const log = view["log"] as HTMLElement;
    expect(log.textContent).toContain("Inbox/A.md");
    expect(log.textContent).toContain("Two gaps.");
    expect(log.textContent).toContain("report");
  });

  it("does not load it while the child runs or when the live timeline is there", async () => {
    let calls = 0;
    const view = new SubagentChildView(slots(), {
      live: false,
      loadTimeline: async () => {
        calls += 1;
        return [];
      },
    });
    view.update({ agent: "explorer", task: "t", status: "running", timelineArtifactId: "art-1" });
    view.update({ agent: "explorer", task: "t", status: "done", timelineArtifactId: "art-1", transcript: [{ type: "text", text: "live" }] });
    await settle();
    expect(calls).toBe(0);
  });
});
