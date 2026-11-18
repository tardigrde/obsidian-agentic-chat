import { describe, expect, it } from "vitest";
import { deadHarnessMessage, driveRuns, HarnessDiedError, inhibitSleep } from "../scripts/eval/run-loop";
import { emptyObservation, type PlannedRun, type RunRecord } from "../scripts/eval/tool-use-plan";

const RUNS: PlannedRun[] = Array.from({ length: 6 }, (_, index) => ({ caseId: `c${index % 2}`, run: index + 1 }));

function okRecord(planned: PlannedRun): RunRecord {
  return { ...planned, ms: 1, usage: {}, modelCalls: 1, observed: { ...emptyObservation(), answer: "ok" } };
}

describe("eval run loop: fail fast on a dead harness (#392 item 5)", () => {
  it("stops at the first invalid session id: runs 4..N are written as harness died, no more calls", async () => {
    const calls: number[] = [];
    const written: RunRecord[] = [];
    const run = driveRuns(
      RUNS,
      async (planned) => {
        calls.push(planned.run);
        if (planned.run === 3) throw new Error("invalid session id: session deleted as the browser has closed the connection\nfrom disconnected");
        return okRecord(planned);
      },
      (record) => written.push(record),
    );
    await expect(run).rejects.toBeInstanceOf(HarnessDiedError);
    await expect(run).rejects.toThrow("harness died: invalid session id");
    expect(calls).toEqual([1, 2, 3]);
    expect(written.map((record) => record.run)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(written.slice(0, 2).every((record) => record.error === undefined)).toBe(true);
    for (const record of written.slice(2)) {
      expect(record.error).toBe("harness died: invalid session id: session deleted as the browser has closed the connection");
      expect(record.modelCalls).toBe(0);
    }
  });

  it("also stops when a run returns a record whose error means a dead harness", async () => {
    const written: RunRecord[] = [];
    const calls: number[] = [];
    await expect(
      driveRuns(
        RUNS,
        async (planned) => {
          calls.push(planned.run);
          return planned.run === 2 ? { ...okRecord(planned), error: "no such window: target window already closed" } : okRecord(planned);
        },
        (record) => written.push(record),
      ),
    ).rejects.toThrow(HarnessDiedError);
    expect(calls).toEqual([1, 2]);
    expect(written).toHaveLength(6);
    expect(written[1].error).toBe("no such window: target window already closed");
    expect(written[2].error).toBe("harness died: no such window: target window already closed");
  });

  it("keeps going on an ordinary run error, and rethrows an unrelated exception", async () => {
    const written: RunRecord[] = [];
    await driveRuns(RUNS, async (planned) => ({ ...okRecord(planned), error: "model request failed: 429" }), (record) => written.push(record));
    expect(written).toHaveLength(6);
    await expect(driveRuns(RUNS, async () => { throw new Error("Plan refers to an unknown case: x"); }, () => undefined)).rejects.toThrow(
      "unknown case",
    );
    expect(deadHarnessMessage("timeout waiting for .agentic-chat-assistant")).toBeUndefined();
  });
});

describe("sleep inhibit wrapper", () => {
  it("wraps the command only when systemd-inhibit exists", () => {
    expect(inhibitSleep("npm", ["run", "test:e2e"], "agentic-chat eval", () => true)).toEqual([
      "systemd-inhibit",
      ["--what=sleep:idle", "--why=agentic-chat eval", "npm", "run", "test:e2e"],
    ]);
    expect(inhibitSleep("npm", ["run", "test:e2e"], "agentic-chat eval", () => false)).toEqual(["npm", ["run", "test:e2e"]]);
  });
});

describe("run wall-time cap (probe)", () => {
  it("kills a child that runs past the cap and rejects with the cap message", async () => {
    const { run } = await import("../scripts/live-support");
    const started = Date.now();
    await expect(
      run(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
        quiet: true,
        timeout: { ms: 200, message: "probe stopped: over the wall-time cap of 0.01 min" },
      }),
    ).rejects.toThrow("over the wall-time cap");
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(run(process.execPath, ["-e", "0"], { quiet: true, timeout: { ms: 10_000, message: "x" } })).resolves.toBe(0);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const { run } = await import("../scripts/live-support");
    const started = Date.now();
    await expect(
      run(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
        quiet: true,
        timeout: { ms: 300, message: "over the cap" },
      }),
    ).rejects.toThrow("over the cap");
    // SIGTERM at 0.3 s is ignored; SIGKILL follows 5 s later.
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it("holds no inhibitor without the binary", async () => {
    const { holdSleepInhibit } = await import("../scripts/eval/run-loop");
    expect(() => holdSleepInhibit("x", () => false)()).not.toThrow();
  });
});
