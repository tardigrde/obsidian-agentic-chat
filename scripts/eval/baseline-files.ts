/**
 * Baseline files. `test/evals/baselines/<suite>.json` is the latest reference
 * that `--compare` reads; `test/evals/baselines/<suite>/<date>-<head>.json` is
 * the append-only history (#393 T21) that the saturation flag reads. Both are
 * written by the live `--write-baseline` and by `--write-baseline-from`, which
 * rebuilds a baseline from a finished run with no model call (#392 item 4).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { baselineRefusal, validateToolUseSuite, type BaselineRefusalSuite } from "./tool-use-core";
import type { ToolUsePlan } from "./tool-use-plan";
import { baselineFileName, toBaseline, type ToolUseBaseline, type ToolUseSummary } from "./tool-use-report";

export const BASELINE_DIR = "test/evals/baselines";

/** `<date>T<hh>-<mm>-<ss>-<head>.json`: sorts by time. A second write in the same second is refused. */
export function baselineHistoryName(date: Date, gitHead: string): string {
  return `${date.toISOString().slice(0, 19).replaceAll(":", "-")}-${gitHead.slice(0, 7)}.json`;
}

export interface WrittenBaseline {
  latest: string;
  history: string;
  baseline: ToolUseBaseline;
}

/** Refuse, or write the latest file and one history file. Throws with the refusal reason. */
export function writeBaselineFiles(options: {
  summary: ToolUseSummary;
  plannedRunCount: number;
  suite: BaselineRefusalSuite;
  gitHead: string;
  date: Date;
  dir?: string;
}): WrittenBaseline {
  const refusal = baselineRefusal(options.summary, options.plannedRunCount, options.suite);
  if (refusal) throw new Error(`Refusing to write baseline: ${refusal}`);
  const dir = options.dir ?? BASELINE_DIR;
  const fileName = baselineFileName(options.summary.suite.name);
  const baseline = toBaseline(options.summary, { date: options.date, gitHead: options.gitHead });
  const latest = path.join(dir, fileName);
  const historyDir = path.join(dir, fileName.replace(/\.json$/, ""));
  const history = path.join(historyDir, baselineHistoryName(options.date, options.gitHead));
  // The history is append-only: never overwrite an entry.
  if (existsSync(history)) throw new Error(`Refusing to write baseline: ${history} already exists.`); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  mkdirSync(historyDir, { recursive: true }); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  const text = `${JSON.stringify(baseline, null, 2)}\n`;
  writeFileSync(latest, text, "utf8"); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  writeFileSync(history, text, "utf8"); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  return { latest, history, baseline };
}

/**
 * `--write-baseline-from <summary.json>`: read the finished run and the
 * `plan.json` next to it, apply the same refusal guard as a live run, and
 * write. The git head is the run's own (recorded in the plan), else `gitHead`.
 */
export function writeBaselineFromSummary(options: {
  summaryPath: string;
  gitHead?: string;
  suitePath?: string;
  date?: Date;
  dir?: string;
}): WrittenBaseline {
  const summary = JSON.parse(readFileSync(options.summaryPath, "utf8")) as ToolUseSummary; // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  const planPath = path.join(path.dirname(options.summaryPath), "plan.json");
  if (!existsSync(planPath)) throw new Error(`no plan.json next to ${options.summaryPath}; a baseline needs the plan of the run`);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as ToolUsePlan; // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  const suitePath = options.suitePath ?? plan.suite.path;
  if (!existsSync(suitePath)) throw new Error(`suite file not found: ${suitePath}; pass --suite`);
  const suite = validateToolUseSuite(JSON.parse(readFileSync(suitePath, "utf8"))); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  const gitHead = plan.gitHead ?? summary.gitHead ?? options.gitHead;
  if (!gitHead) throw new Error("the run recorded no git head; pass --git-head <sha>");
  return writeBaselineFiles({
    summary,
    plannedRunCount: plan.runs.length,
    suite,
    gitHead,
    date: options.date ?? finishDate(summary),
    dir: options.dir,
  });
}

function finishDate(summary: ToolUseSummary): Date {
  const date = new Date(summary.finishedAt);
  if (Number.isNaN(date.getTime())) throw new Error("the run recorded no finish time (summary.finishedAt); it cannot date a baseline");
  return date;
}

/** History files of one suite, oldest first. */
export function readBaselineHistory(suiteName: string, dir = BASELINE_DIR): ToolUseBaseline[] {
  const historyDir = path.join(dir, baselineFileName(suiteName).replace(/\.json$/, ""));
  if (!existsSync(historyDir)) return [];
  return readdirSync(historyDir)
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => JSON.parse(readFileSync(path.join(historyDir, name), "utf8")) as ToolUseBaseline);
}

/** A case at pass^k this many baselines in a row is saturated: it no longer moves. */
export const SATURATION_STREAK = 3;

/**
 * Cases at pass^k = 1 in each of the last `streak` baselines (#393 T21).
 * Older files call the field `passAtK`. Only baselines with the same case set
 * as the newest one count: a suite that was cut (27 -> 12 cases in #393 T20)
 * starts a new streak. Fewer such baselines than the streak: none.
 */
export function saturatedCases(history: readonly ToolUseBaseline[], streak = SATURATION_STREAK): string[] {
  const shape = (baseline: ToolUseBaseline) => baseline.cases.map((entry) => entry.id).sort((a, b) => a.localeCompare(b)).join("\n");
  const newest = history.at(-1);
  const same = newest ? history.filter((baseline) => shape(baseline) === shape(newest)) : [];
  if (same.length < streak) return [];
  const recent = same.slice(-streak);
  const full = (baseline: ToolUseBaseline) =>
    new Set(
      baseline.cases
        .filter((entry) => ((entry as { passAllK?: number }).passAllK ?? (entry as { passAtK?: number }).passAtK) === 1)
        .map((entry) => entry.id),
    );
  const [first, ...rest] = recent.map(full);
  return [...first].filter((id) => rest.every((set) => set.has(id))).sort((left, right) => left.localeCompare(right));
}
