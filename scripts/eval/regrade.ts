/**
 * `npm run eval:explain -- --regrade <run dir> [--suite <path>]` (#393 T21):
 * grade the saved run records of an old run again with the checks of the
 * current suite file. No model call and no Obsidian: a fixed check can be
 * proved on runs that already happened.
 *
 * The seed stays the one the run used (from its plan.json); only the checks
 * come from the suite. A case the suite no longer has is reported, not graded.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { validateToolUseSuite, type RunPricing, type ToolUseCase } from "./tool-use-core";
import { parseRunRecord, type ToolUsePlan } from "./tool-use-plan";
import { gradeRecord } from "./tool-use-report";

export interface RegradeRow {
  caseId: string;
  run: number;
  before: string;
  after: string;
}

export interface RegradeResult {
  rows: RegradeRow[];
  /** Plan cases the suite file no longer has. */
  missingCases: string[];
}

interface SummaryRuns {
  cases?: Array<{ id: string; runResults?: Array<{ run: number; status: string }> }>;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T; // NOSONAR:S8707 -- local dev CLI: a file in the developer's own run directory.
}

/** Grade every saved record of `runDir` with the checks of `suiteCases`. */
export function regradeRun(runDir: string, suiteCases: readonly ToolUseCase[]): RegradeResult {
  const plan = readJson<ToolUsePlan>(path.join(runDir, "plan.json"));
  const summaryPath = path.join(runDir, "summary.json");
  const summary = existsSync(summaryPath) ? readJson<SummaryRuns>(summaryPath) : {};
  const before = new Map<string, string>();
  for (const entry of summary.cases ?? []) {
    for (const run of entry.runResults ?? []) before.set(`${entry.id}#${run.run}`, run.status);
  }
  const current = new Map(suiteCases.map((evalCase) => [evalCase.id, evalCase]));
  const planned = new Map(plan.cases.map((evalCase) => [evalCase.id, evalCase]));
  const rows: RegradeRow[] = [];
  const missing = new Set<string>();
  for (const { caseId, run } of plan.runs) {
    const fresh = current.get(caseId);
    const used = planned.get(caseId);
    if (!fresh || !used) {
      missing.add(caseId);
      continue;
    }
    const recordPath = path.join(runDir, "results", caseId, `${run}.json`);
    if (!existsSync(recordPath)) continue;
    const record = parseRunRecord(readJson<unknown>(recordPath), recordPath);
    const evalCase: ToolUseCase = { ...used, checks: fresh.checks, expected: fresh.expected };
    const graded = gradeRecord(evalCase, record, plan.prices as RunPricing);
    rows.push({ caseId, run, before: before.get(`${caseId}#${run}`) ?? "?", after: graded.status });
  }
  return { rows, missingCases: [...missing] };
}

export function loadSuiteCases(suitePath: string): ToolUseCase[] {
  return validateToolUseSuite(readJson<unknown>(suitePath)).cases;
}

export function formatRegrade(result: RegradeResult): string {
  const changed = result.rows.filter((row) => row.before !== row.after);
  const lines = [
    `Regraded ${result.rows.length} run(s) with the current checks; ${changed.length} changed.`,
    "",
    "| Case | Run | Before | After |",
    "|---|---:|---|---|",
    ...result.rows.map((row) => `| ${row.caseId} | ${row.run} | ${row.before} | ${row.before === row.after ? row.after : `**${row.after}**`} |`),
  ];
  if (result.missingCases.length > 0) {
    lines.push("", `Not in the suite any more (not graded): ${result.missingCases.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
