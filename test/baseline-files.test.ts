import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBaselineHistory, writeBaselineFromSummary } from "../scripts/eval/baseline-files";
import type { ToolUseCase } from "../scripts/eval/tool-use-core";
import { emptyObservation, type RunRecord, type ToolUsePlan } from "../scripts/eval/tool-use-plan";
import { buildSummary, gradeRecord } from "../scripts/eval/tool-use-report";

const PRICES = { input: 1e-6, output: 2e-6, cacheRead: 0 };
const CASE: ToolUseCase = {
  id: "case.one",
  prompt: "Say done.",
  seed: { files: {}, binaryFiles: {} },
  checks: [{ type: "answer_contains", text: "done" }],
  expected: { maxToolCalls: 1 },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "baseline-files-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function record(run: number, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    caseId: CASE.id,
    run,
    ms: 2_000,
    usage: { input: 1_000, output: 500, totalTokens: 1_500 },
    modelCalls: 1,
    observed: { ...emptyObservation(), answer: "done" },
    ...overrides,
  };
}

/** A finished run on disk: suite file, plan.json, summary.json. Returns the summary path. */
function writeRun(records: RunRecord[], options: { gitHead?: string } = {}): string {
  const suitePath = path.join(dir, "unit.eval.json");
  writeFileSync(suitePath, JSON.stringify({
      version: 1,
      name: "unit",
      model: "deepseek/deepseek-v4.1-flash",
      runsPerCase: 2,
      budget: { maxUsd: 1, maxModelCalls: 100, maxTokens: 1_000_000 },
      turn: { timeoutMs: 1_000, maxTurnsPerPrompt: 5 },
      cases: [CASE],
    }));
  const plan: ToolUsePlan = {
    version: 1,
    runId: "run-1",
    suite: { name: "unit", path: suitePath },
    model: "m",
    runsPerCase: 2,
    thinkingLevel: "low",
    thinkingLevelSource: "suite",
    budget: { maxUsd: 1, maxModelCalls: 100, maxTokens: 1_000_000 },
    turn: { timeoutMs: 1_000, maxTurnsPerPrompt: 5 },
    prices: PRICES,
    ...(options.gitHead ? { gitHead: options.gitHead } : {}),
    cases: [CASE],
    runs: [1, 2].map((run) => ({ caseId: CASE.id, run })),
  };
  const runDir = path.join(dir, "run-1");
  const summary = buildSummary(plan, new Map([[CASE.id, records.map((entry) => gradeRecord(CASE, entry, PRICES))]]), {
    startedAt: new Date("2026-11-17T09:00:00Z"),
    finishedAt: new Date("2026-11-17T09:01:00Z"),
  });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(plan));
  const summaryPath = path.join(runDir, "summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary));
  return summaryPath;
}

describe("--write-baseline-from (#392 item 4)", () => {
  it("writes the latest baseline and one history file from a finished run, with the run's git head", () => {
    const summaryPath = writeRun([record(1), record(2)], { gitHead: "abcdef1234567" });
    const out = path.join(dir, "baselines");
    const written = writeBaselineFromSummary({ summaryPath, dir: out });

    expect(written.latest).toBe(path.join(out, "unit.json"));
    expect(written.history).toBe(path.join(out, "unit", "2026-11-17T09-01-00-abcdef1.json"));
    const latest = JSON.parse(readFileSync(written.latest, "utf8"));
    expect(latest).toMatchObject({ suite: "unit", gitHead: "abcdef1234567", date: "2026-11-17T09:01:00.000Z" });
    expect(latest.cases).toEqual([expect.objectContaining({ id: CASE.id, passAllK: 1, executed: 2 })]);
    expect(readFileSync(written.history, "utf8")).toBe(readFileSync(written.latest, "utf8"));
    expect(readBaselineHistory("unit", out)).toHaveLength(1);
  });

  it("refuses a run with a harness error and writes nothing", () => {
    const summaryPath = writeRun([record(1), record(2, { error: "invalid session id" })], { gitHead: "abc1234" });
    const out = path.join(dir, "baselines");
    expect(() => writeBaselineFromSummary({ summaryPath, dir: out })).toThrow(
      "Refusing to write baseline: 1 run(s) have a harness error",
    );
    expect(readBaselineHistory("unit", out)).toEqual([]);
  });

  it("needs --git-head when the run recorded none", () => {
    const summaryPath = writeRun([record(1), record(2)]);
    const out = path.join(dir, "baselines");
    expect(() => writeBaselineFromSummary({ summaryPath, dir: out })).toThrow("pass --git-head");
    expect(writeBaselineFromSummary({ summaryPath, dir: out, gitHead: "1234567890" }).baseline.gitHead).toBe("1234567890");
  });
});
