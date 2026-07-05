import { describe, expect, it } from "vitest";
import {
  healPlanTrackerState,
  planTrackerRows,
  runPlanTrackerCommand,
  summarizePlanTracker,
  type PlanTrackerState,
} from "../src/agent/plan-tracker";

const NOW = "2026-06-26T12:00:00.000Z";

describe("plan tracker", () => {
  it("adds milestones and tracks status, test status, and checkpoint commits", () => {
    let state: PlanTrackerState | null = null;
    let result = runPlanTrackerCommand(state, "add Milestone 20 plan tracker", NOW);
    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(true);
    state = result.state;

    result = runPlanTrackerCommand(state, "set 1 active", NOW);
    state = result.state;
    result = runPlanTrackerCommand(state, "test 1 passed", NOW);
    state = result.state;
    result = runPlanTrackerCommand(state, "commit 1 9ce94b8", NOW);
    state = result.state;

    expect(state?.items).toEqual([
      expect.objectContaining({
        id: "1",
        title: "Milestone 20 plan tracker",
        status: "in_progress",
        testStatus: "passed",
        checkpointCommit: "9ce94b8",
      }),
    ]);
    expect(summarizePlanTracker(state!)).toBe("0/1 done · tests 1/1 passed · 1 checkpoint commits");
  });

  it("reports invalid commands without changing current state", () => {
    const state = runPlanTrackerCommand(null, "add First", NOW).state;
    const result = runPlanTrackerCommand(state, "test 99 passed", NOW);

    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
    expect(result.error).toBe('No tracked milestone "99".');
  });

  it("clears and heals persisted tracker state", () => {
    const state = runPlanTrackerCommand(null, "add First", NOW).state;
    expect(runPlanTrackerCommand(state, "clear", NOW)).toMatchObject({ state: null, changed: true });

    expect(
      healPlanTrackerState({
        version: 99,
        title: "Recovered",
        updatedAt: NOW,
        items: [
          { id: "1", title: "Kept", status: "complete", testStatus: "green", checkpointCommit: "abc123" },
          { id: "", title: "Dropped" },
        ],
      }),
    ).toEqual({
      version: 1,
      title: "Recovered",
      updatedAt: NOW,
      items: [
        expect.objectContaining({
          id: "1",
          title: "Kept",
          status: "done",
          testStatus: "passed",
          checkpointCommit: "abc123",
        }),
      ],
    });
  });

  it("formats command result rows for in-pane status output", () => {
    const result = runPlanTrackerCommand(null, "add Milestone", NOW);
    const rows = planTrackerRows(result.state, result.message);

    expect(rows).toEqual([
      ["Status", "Added 1: Milestone."],
      ["Summary", "0/1 done · tests 0/1 passed · 0 checkpoint commits"],
      ["1", "Milestone · pending · tests not run"],
    ]);
  });
});
