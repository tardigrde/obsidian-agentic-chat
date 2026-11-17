#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the status report. */
import process from "node:process";
import { pathToFileURL } from "node:url";
import { historyPath, readHistory, summarizeHistory } from "./lib/run-result.mjs";

/**
 * `npm run tests:status`: is this flaky, did it get slower, what was the last
 * red, what do live runs cost. Reads logs/history.jsonl in the main worktree.
 * Advisory: it never fails.
 */

function short(head) {
  return head ? head.slice(0, 8) : "(no head)";
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatStatus(summary, file) {
  const lines = [`tests:status: ${summary.runs} run(s) in ${file}`];
  if (summary.runs === 0) {
    lines.push("No history yet. Every `npm run verify -- <lane>` run appends one line.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("", "Lanes (last run, pass rate, last red):");
  for (const row of summary.lanes.sort((a, b) => a.lane.localeCompare(b.lane))) {
    const last = row.last;
    const red = row.lastRed ? `last red ${row.lastRed.startedAt} at ${short(row.lastRed.head)}` : "never red";
    lines.push(
      `  ${row.lane.padEnd(8)} ${last.verdict.padEnd(4)} ${last.startedAt} ${short(last.head)} ${(last.branch ?? "").padEnd(20)} ` +
        `${row.runs} run(s), ${Math.round(row.passRate * 100)}% pass, ${red}`,
    );
  }
  lines.push("", `Flaky (failed and passed on the same head): ${summary.flaky.length}`);
  for (const row of summary.flaky) lines.push(`  ${row.id}  (${row.failures} failure(s) on ${row.heads.map(short).join(", ")})`);
  lines.push("", `Slower steps (median of the last 5 passing runs vs the 5 before): ${summary.slowerSteps.length}`);
  for (const row of summary.slowerSteps) {
    lines.push(`  ${row.lane} / ${row.label}: ${seconds(row.beforeMs)} -> ${seconds(row.recentMs)}`);
  }
  lines.push("", `Slower tests (latest vs median of earlier runs): ${summary.slowerTests.length}`);
  for (const row of summary.slowerTests.slice(0, 10)) lines.push(`  ${row.id}: ${row.beforeMs}ms -> ${row.latestMs}ms`);
  if (summary.cost.length > 0) {
    lines.push("", "Live cost (last 10 runs with a cost):");
    for (const row of summary.cost) lines.push(`  ${row.startedAt} ${row.lane} $${row.usd.toFixed(4)}`);
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: npm run tests:status [-- --json] [-- --file <history.jsonl>]\n\n" +
        "Flaky tests, slower steps and tests, last red per lane, live cost. Reads logs/history.jsonl\n" +
        "in the main worktree (every worktree appends there).",
    );
    return;
  }
  const fileIndex = process.argv.indexOf("--file");
  const file = fileIndex > 0 ? process.argv[fileIndex + 1] : historyPath();
  const summary = summarizeHistory(readHistory(file));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  process.stdout.write(formatStatus(summary, file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
