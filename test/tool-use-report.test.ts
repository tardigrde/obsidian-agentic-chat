import { describe, expect, it } from "vitest";
import { gradeRun, summarizeCase, type ToolUseCase } from "../scripts/eval/tool-use-core";
import { emptyObservation, parseRunRecord, type RunRecord, type ToolUsePlan } from "../scripts/eval/tool-use-plan";
import {
  baselineFileName,
  buildSummary,
  formatConsoleSummary,
  formatDryRun,
  formatReport,
  gradeRecord,
  missingRunEntry,
  toBaseline,
} from "../scripts/eval/tool-use-report";

const PRICES = { input: 1e-6, output: 2e-6, cacheRead: 0 };

const CASE: ToolUseCase = {
  id: "case.one",
  prompt: "Say done and keep a.md.",
  seed: { files: { "a.md": "A" }, binaryFiles: {} },
  checks: [
    { type: "answer_contains", text: "done" },
    { type: "unchanged", path: "a.md" },
  ],
  expected: { maxToolCalls: 1 },
};

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    caseId: CASE.id,
    run: 1,
    ms: 2_000,
    usage: { input: 1_000, output: 500, totalTokens: 1_500 },
    modelCalls: 2,
    observed: { ...emptyObservation(), files: { "a.md": "A" }, paths: ["a.md"], answer: "done" },
    ...overrides,
  };
}

function plan(): ToolUsePlan {
  return {
    version: 1,
    runId: "run-1",
    suite: { name: "unit", path: "/suites/unit.eval.json" },
    model: "deepseek/deepseek-v4.1-flash",
    runsPerCase: 3,
    thinkingLevel: "low",
    thinkingLevelSource: "suite",
    budget: { maxUsd: 1, maxModelCalls: 100, maxTokens: 1_000_000 },
    turn: { timeoutMs: 1_000, maxTurnsPerPrompt: 5 },
    prices: PRICES,
    cases: [CASE],
    runs: [1, 2, 3].map((run) => ({ caseId: CASE.id, run })),
  };
}

describe("tool-use grading", () => {
  it("reads file_exists and file_absent from every vault path, not only Markdown", () => {
    const checks: ToolUseCase["checks"] = [
      { type: "file_exists", path: "Archive/invoice.pdf" },
      { type: "file_absent", path: "Inbox/invoice.pdf" },
    ];
    const moved = gradeRun(
      { ...CASE, checks },
      { ...emptyObservation(), paths: ["Archive/invoice.pdf", "a.md"] },
    );
    expect(moved.ok).toBe(true);

    const notMoved = gradeRun({ ...CASE, checks }, { ...emptyObservation(), paths: ["Inbox/invoice.pdf"] });
    expect(notMoved.checks.map((check) => check.ok)).toEqual([false, false]);
  });

  it("falls back to the Markdown paths for a record without a path list", () => {
    const { paths: _paths, ...withoutPaths } = emptyObservation();
    const grade = gradeRun(
      { ...CASE, checks: [{ type: "file_exists", path: "a.md" }] },
      { ...withoutPaths, files: { "a.md": "A" } },
    );
    expect(grade.ok).toBe(true);
  });

  it("scores the share of passed checks", () => {
    const grade = gradeRun(CASE, { ...emptyObservation(), files: { "a.md": "changed" }, answer: "done" });
    expect(grade).toMatchObject({ ok: false, score: 0.5 });
    expect(gradeRun({ ...CASE, checks: [] }, emptyObservation()).score).toBe(0);
  });
});

describe("tool-use run entries", () => {
  it("passes a record whose checks pass and prices its usage", () => {
    const entry = gradeRecord(CASE, record(), PRICES);
    expect(entry).toMatchObject({ status: "pass", partialScore: 1, toolCalls: 0, modelCalls: 2 });
    expect(entry.usd).toBeCloseTo(0.002);
    expect(entry.error).toBeUndefined();
  });

  it("fails a record whose checks fail", () => {
    const entry = gradeRecord(CASE, record({ observed: { ...emptyObservation(), answer: "no" } }), PRICES);
    expect(entry).toMatchObject({ status: "fail", partialScore: 0 });
  });

  it("reports a harness error as error, even when every check passes, and keeps its spend", () => {
    const entry = gradeRecord(CASE, record({ error: "model request failed: 429" }), PRICES);
    expect(entry).toMatchObject({ status: "error", error: "model request failed: 429", partialScore: 1 });
    expect(entry.usd).toBeGreaterThan(0);
  });

  it("reports a budget skip with the cap and no spend", () => {
    const entry = gradeRecord(CASE, record({ skippedBudget: "maxUsd ($1 spent, cap $1)" }), PRICES);
    expect(entry).toMatchObject({ status: "skipped-budget", usd: 0, checks: [], error: "maxUsd ($1 spent, cap $1)" });
  });

  it("counts errors apart from failures in the case summary", () => {
    const summary = summarizeCase([
      gradeRecord(CASE, record(), PRICES),
      gradeRecord(CASE, record({ run: 2, error: "boom" }), PRICES),
      missingRunEntry({ caseId: CASE.id, run: 3 }, "no run record was written"),
    ]);
    expect(summary).toMatchObject({ runs: 3, executed: 3, passed: 1, errored: 2, passAllK: 0 });
    expect(summary.passRate).toBeCloseTo(1 / 3);
  });
});

describe("tool-use billed cost", () => {
  it("uses the USD the provider billed over the price table", () => {
    const entry = gradeRecord(CASE, record({ usage: { input: 1_000, output: 500, billedUsd: 0.005 } }), PRICES);
    expect(entry.usd).toBe(0.005);
    expect(entry.usdSource).toBe("billed");
  });

  it("falls back to the price table when no billed cost was recorded", () => {
    const entry = gradeRecord(CASE, record(), PRICES);
    expect(entry.usd).toBeCloseTo(1_000 * 1e-6 + 500 * 2e-6, 12);
    expect(entry.usdSource).toBe("table");
  });

  it("keeps the billed cost when the run record is read back from disk", () => {
    const raw = JSON.parse(JSON.stringify(record({ usage: { input: 10, billedUsd: 0.25 } }))) as unknown;
    expect(parseRunRecord(raw, "1.json").usage.billedUsd).toBe(0.25);
  });

  it("names the cost source in the report", () => {
    const summary = buildSummary(
      { ...plan(), runs: [{ caseId: CASE.id, run: 1 }, { caseId: CASE.id, run: 2 }] },
      new Map([[CASE.id, [
        gradeRecord(CASE, record({ usage: { billedUsd: 0.01 } }), PRICES),
        gradeRecord(CASE, record({ run: 2 }), PRICES),
      ]]]),
      { startedAt: new Date(0), finishedAt: new Date(1_000) },
    );
    expect(formatReport(summary)).toContain("Cost source: billed by the provider for 1/2 run(s)");
    expect(summary.costSource).toBe("mixed");
    const nothingSpent = buildSummary(plan(), new Map([[CASE.id, [missingRunEntry({ caseId: CASE.id, run: 1 }, "no record")]]]), {
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
    expect(nothingSpent.costSource).toBe("none");
    expect(toBaseline(summary, { date: new Date(0), gitHead: "abc" }).costSource).toBe("mixed");
    expect(summary.budget.used.usd).toBeCloseTo(0.01 + 1_000 * 1e-6 + 500 * 2e-6, 12);
  });
});

describe("tool-use summary and report", () => {
  const entries = new Map([
    [
      CASE.id,
      [
        gradeRecord(CASE, record(), PRICES),
        gradeRecord(CASE, record({ run: 2, observed: { ...emptyObservation(), answer: "no" } }), PRICES),
        missingRunEntry({ caseId: CASE.id, run: 3 }, "no run record was written (the WDIO spec exited with code 1)"),
      ],
    ],
  ]);
  const timing = { startedAt: new Date("2026-01-01T00:00:00Z"), finishedAt: new Date("2026-01-01T00:01:00Z") };
  const summary = buildSummary(plan(), entries, timing);

  it("builds the summary from the plan and the graded entries", () => {
    expect(summary).toMatchObject({
      runId: "run-1",
      suite: { name: "unit" },
      durationMs: 60_000,
      budget: { used: { modelCalls: 4, tokens: 3_000 }, exceeded: null },
      overall: { cases: 1, runs: 3, passAllK: 0 },
    });
    expect(summary.cases[0]).toMatchObject({ id: CASE.id, passed: 1, errored: 1, executed: 3 });
    expect(summary.budget.used.usd).toBeCloseTo(0.004);
  });

  it("lists failed checks and harness errors per run in the report", () => {
    const report = formatReport(summary);
    expect(report).toContain("| case.one | low | 1/3 | 0 |");
    expect(report).toContain("### case.one run 2 (fail)");
    expect(report).toContain('- answer_contains: answer does not contain "done"');
    expect(report).toContain("### case.one run 3 (error)");
    expect(report).toContain("- run error: no run record was written (the WDIO spec exited with code 1)");
    expect(report).not.toContain("### case.one run 1");
  });

  it("says in the console summary that harness errors are not model failures", () => {
    const text = formatConsoleSummary(summary, { summary: "s.json", report: "r.md" });
    expect(text).toContain("Harness errors: 1 run(s)");
    expect(text).toContain("Summary: s.json");
  });

  it("writes a baseline without the per-run detail", () => {
    const baseline = toBaseline(summary, { date: new Date("2026-01-02T00:00:00Z"), gitHead: "abc123" });
    expect(baseline).toMatchObject({ suite: "unit", gitHead: "abc123", date: "2026-01-02T00:00:00.000Z" });
    expect(baseline.cases).toEqual([expect.objectContaining({ id: CASE.id, passAllK: 0 })]);
    expect(baseline.cases[0]).not.toHaveProperty("runResults");
  });

  it("names the baseline file after the suite", () => {
    expect(baselineFileName("core")).toBe("core.json");
    expect(baselineFileName(" My Suite! ")).toBe("my-suite.json");
    expect(() => baselineFileName("///")).toThrow(/cannot be used as a baseline file name/);
  });

  it("derives the dry-run estimate line from its own assumption", () => {
    const text = formatDryRun({
      suite: { name: "unit", path: "/suites/unit.eval.json", model: "m" },
      cases: [CASE],
      runsPerCase: 2,
      budget: plan().budget,
      turn: plan().turn,
      outDir: "/out",
      thinking: { level: "low", source: "default" },
    });
    expect(text).toContain("1 case(s) x 2 run(s) = 2 run(s)");
    expect(text).toContain("- case.one: 2 run(s), 1 seed file(s)");
    expect(text).toContain(
      "estimated cost: $0.0024 (fixed assumption: 15k tokens/run, 80% input at $0.05/M and 20% output at $0.20/M)",
    );
  });
});
