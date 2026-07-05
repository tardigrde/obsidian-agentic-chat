import { describe, expect, it } from "vitest";
import { buildPlanTrackerPanelState } from "../src/ui/plan-tracker-panel";
import { runPlanTrackerCommand, type PlanTrackerState } from "../src/agent/plan-tracker";

const NOW = "2026-06-26T12:00:00.000Z";

function apply(state: PlanTrackerState | null, command: string): PlanTrackerState | null {
  return runPlanTrackerCommand(state, command, NOW).state;
}

describe("plan tracker panel state", () => {
  it("hides when there is no tracked plan", () => {
    expect(buildPlanTrackerPanelState(null)).toEqual({ visible: false, title: "", summary: "", items: [] });
  });

  it("renders milestone, test, and checkpoint commit display state", () => {
    let state: PlanTrackerState | null = null;
    state = apply(state, "add Milestone 20");
    state = apply(state, "set 1 done");
    state = apply(state, "test 1 passed");
    state = apply(state, "commit 1 05486c8");
    state = apply(state, "note 1 full checkpoint passed");

    expect(buildPlanTrackerPanelState(state)).toEqual({
      visible: true,
      title: "Plan tracker",
      summary: "1/1 done · tests 1/1 passed · 1 checkpoint commits",
      items: [
        {
          id: "1",
          title: "Milestone 20",
          status: "done",
          statusLabel: "done",
          testStatus: "passed",
          testLabel: "tests passed",
          checkpointCommit: "05486c8",
          note: "full checkpoint passed",
        },
      ],
    });
  });
});
