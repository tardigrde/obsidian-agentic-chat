import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUN_REPORT_ENV,
  RUN_RESULT_SCHEMA,
  buildRunResult,
  mergeRunReports,
  readRunReport,
  writeRunReport,
} from "../scripts/lib/run-result.mjs";
import { mochaCounts, zeroTestFailure } from "../scripts/live-support";
import { lanes } from "../scripts/verify-lanes.mjs";

/**
 * One app runner, one report (#393 T23). A recorded run (`app --record`) and
 * an explore dry run (`explore`) both go through verify, and each child adds
 * its spend and folder through the run report file, so both envelopes have
 * the same shape.
 */

type Step = { label: string; tier?: string; mode?: string; expectTests: boolean };
const build = (name: string, args: string[]) => (lanes as Record<string, (a: string[]) => Step[]>)[name](args);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envelopeFor(lane: string, args: string[], report: { tokens: number; usd: number; artifacts: string[] }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "app-report-"));
  dirs.push(dir);
  const file = path.join(dir, "report.json");
  expect(writeRunReport(report, { [RUN_REPORT_ENV]: file })).toBe(true);
  const merged = mergeRunReports([readRunReport(file)]);
  const steps = build(lane, args).map((entry) => ({
    ...entry,
    status: "PASS",
    durationMs: 1000,
    counts: { passed: 1, failed: 0, skipped: 0, total: 1 },
  }));
  return buildRunResult({
    lane,
    args,
    command: `npm run verify -- ${[lane, ...args].join(" ")}`,
    verdict: "PASS",
    startedAt: 0,
    finishedAt: 1000,
    steps,
    cost: merged.cost,
    artifacts: ["logs/verify/x/summary.json", ...merged.artifacts],
    git: { head: "abc", branch: "b", dirty: false, worktree: "/w" },
  });
}

describe("one app report schema", () => {
  it("gives a recorded run and an explore dry run the same envelope keys, with mode, cost, and artifacts", () => {
    const recorded = envelopeFor("app", ["--record", "layout-smoke"], { tokens: 0, usd: 0, artifacts: ["logs/probes/r1"] });
    const explored = envelopeFor("explore", ["--mode", "smoke"], { tokens: 1200, usd: 0, artifacts: ["logs/chaos/c1"] });

    expect(Object.keys(recorded).sort()).toEqual(Object.keys(explored).sort());
    for (const envelope of [recorded, explored]) {
      expect(envelope.schema).toBe(RUN_RESULT_SCHEMA);
      expect(envelope.mode).toBe("scripted");
      expect(envelope.verdict).toBe("PASS");
      expect(envelope.counts.total).toBe(1);
    }
    expect(recorded.command).toBe("npm run verify -- app --record layout-smoke");
    expect(recorded.artifacts).toEqual(["logs/verify/x/summary.json", "logs/probes/r1"]);
    expect(explored.cost).toEqual({ tokens: 1200, usd: 0 });
    expect(recorded.tiers.T4).toMatchObject({ steps: 1, passed: 1 });
  });

  it("writes no report without the parent's variable, and reads a torn file as none", () => {
    expect(writeRunReport({ tokens: 1 }, {})).toBe(false);
    expect(readRunReport(undefined)).toBeUndefined();
    expect(mergeRunReports([undefined])).toEqual({ cost: undefined, artifacts: [] });
  });
});

describe("recorded run honesty", () => {
  it("fails a green exit with no executed test, or with a skipped test", () => {
    expect(zeroTestFailure(mochaCounts("Spec Files: 1 passed\n"))).toBe("no test summary: 0 tests executed");
    expect(zeroTestFailure(mochaCounts("  0 passing (2s)\n"))).toBe("0 tests executed");
    expect(zeroTestFailure(mochaCounts("  1 pending\n"))).toBe("0 tests executed");
    expect(zeroTestFailure(mochaCounts("  2 passing (3s)\n  1 pending\n"))).toMatch(/1 test\(s\) skipped/);
    expect(zeroTestFailure(mochaCounts("  3 passing (4s)\n"))).toBeUndefined();
    expect(mochaCounts("  3 passing (4s)\n  1 failing\n")).toEqual({ passed: 3, failed: 1, skipped: 0 });
  });
});
