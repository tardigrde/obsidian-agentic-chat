#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the digest. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { historyPath, readHistory, summarizeHistory } from "./lib/run-result.mjs";

/**
 * Defect history as data (#393 T25).
 *
 *   npm run tests:status -- --digest [--since <iso>] [--until <iso>]
 *   npm run tests:status -- --digest --write-defects
 *
 * The digest reads the gate runs of a window from GitHub (`ci`, `witness`,
 * `review`), the `Found by:` line of the PRs merged in it, and the local
 * history (flaky tests). It prints gate reds by conclusion and by cause, the
 * flakes, and the catches per layer. `--write-defects` regenerates the table
 * in docs/development/escaped-defects.md from the PR bodies. Advisory: it
 * never fails a build. The default window is the last 7 days.
 */

export const GATES = [
  { name: "ci", workflow: "ci.yml" },
  { name: "witness", workflow: "witness.yml" },
  { name: "review", workflow: "review.yml" },
];
export const RED_CONCLUSIONS = new Set(["failure", "startup_failure", "timed_out"]);
export const FOUND_BY = ["review", "chaos", "e2e", "unit", "eval", "user", "ci", "dogfood"];
export const DEFECTS_FILE = "docs/development/escaped-defects.md";
const START = "<!-- generated: defects start -->";
const END = "<!-- generated: defects end -->";

/** Red runs of one gate, with a count per conclusion ("none" when GitHub recorded no conclusion). */
export function countRuns(runs) {
  const byConclusion = {};
  let reds = 0;
  for (const run of runs) {
    const conclusion = run.conclusion || "none";
    byConclusion[conclusion] = (byConclusion[conclusion] ?? 0) + 1;
    if (RED_CONCLUSIONS.has(conclusion)) reds += 1;
  }
  return { total: runs.length, reds, byConclusion };
}

/**
 * A triage aid, not a verdict: the cause of a failed run from its failed-step
 * log. First match wins.
 */
const CAUSES = [
  { cause: "process", pattern: /no verdict at head|witness block|missing witness|size budget|review gate/i },
  { cause: "infra", pattern: /ECONNRESET|ETIMEDOUT|rate limit|503 Service|runner .* lost|No space left|startup_failure/i },
  { cause: "flake", pattern: /element click intercepted|modal-bg|stale element|timed? ?out waiting|waitUntil condition timed out/i },
];
export function classifyFailure(log) {
  for (const entry of CAUSES) if (entry.pattern.test(log)) return entry.cause;
  return "real";
}

/** The layer a fix PR names in its `Found by:` line, or undefined. */
export function foundBy(body) {
  const match = /^\s*Found by:\s*`?([a-z0-9-]+)`?/im.exec(body ?? "");
  if (!match) return undefined;
  const layer = match[1].toLowerCase();
  return FOUND_BY.includes(layer) ? layer : undefined;
}

export function tallyFoundBy(prs) {
  const tally = Object.fromEntries(FOUND_BY.map((layer) => [layer, 0]));
  let unlabelled = 0;
  for (const pr of prs) {
    const layer = foundBy(pr.body);
    if (layer) tally[layer] += 1;
    else unlabelled += 1;
  }
  return { tally, unlabelled };
}

export function formatDigest({ since, until, gates, causes, foundByTally, flaky }) {
  const lines = [`Gate digest ${since} .. ${until}`, "", "Gate reds (failure, startup_failure, timed_out):"];
  for (const gate of gates) {
    const parts = Object.entries(gate.counts.byConclusion)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([conclusion, count]) => `${conclusion} ${count}`);
    lines.push(`  ${gate.name.padEnd(8)} ${String(gate.counts.reds).padStart(4)} red of ${gate.counts.total} (${parts.join(", ")})`);
  }
  if (causes) {
    lines.push("", "CI reds by cause (keyword triage of the failed-step logs):");
    for (const [cause, count] of Object.entries(causes)) lines.push(`  ${cause.padEnd(8)} ${count}`);
  }
  lines.push("", `Flaky tests in the local history: ${flaky.length}`);
  for (const row of flaky.slice(0, 10)) lines.push(`  ${row.id}`);
  lines.push("", "Catches per layer (Found by: in merged PR bodies):");
  for (const [layer, count] of Object.entries(foundByTally.tally)) if (count > 0) lines.push(`  ${layer.padEnd(8)} ${count}`);
  lines.push(`  (no Found by: line: ${foundByTally.unlabelled} PR(s))`);
  return `${lines.join("\n")}\n`;
}

/** Escaped-defect rows from merged fix PRs that name the layer that found the defect. */
export function defectRows(prs) {
  return prs
    .filter((pr) => foundBy(pr.body))
    .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)))
    .map((pr) => `| ${String(pr.mergedAt).slice(0, 10)} | #${pr.number} | ${pr.title.replaceAll("|", "\\|")} | ${foundBy(pr.body)} |`);
}

export function renderDefects(doc, rows) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < start) throw new Error(`${DEFECTS_FILE} has no generated block (${START} ... ${END})`);
  const table = ["| Merged | PR | Fix | Found by |", "|---|---|---|---|", ...(rows.length > 0 ? rows : ["| — | — | no fix PR with a `Found by:` line yet | — |"])];
  return `${doc.slice(0, start + START.length)}\n${table.join("\n")}\n${doc.slice(end)}`;
}

function gh(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })); // NOSONAR:S4036 -- gh from PATH, the developer's own GitHub CLI.
}

function failedLog(id) {
  try {
    return execFileSync("gh", ["run", "view", String(id), "--log-failed"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); // NOSONAR:S4036 -- gh from PATH.
  } catch {
    return "";
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

export function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: npm run tests:status -- --digest [--since <iso>] [--until <iso>] [--classify] [--write-defects]\n\n" +
        "Gate reds of ci, witness, and review in the window (GitHub), CI reds by cause with --classify,\n" +
        "flaky tests (local history), and catches per layer (Found by: in merged PR bodies).",
    );
    return;
  }
  const until = argValue("--until") ?? new Date().toISOString();
  const since = argValue("--since") ?? new Date(Date.parse(until) - 7 * 24 * 3600 * 1000).toISOString();
  const window = `${since}..${until}`;
  const gates = GATES.map((gate) => {
    const runs = gh(["run", "list", "--workflow", gate.workflow, "--created", window, "--limit", "5000", "--json", "databaseId,conclusion"]);
    return { ...gate, runs, counts: countRuns(runs) };
  });
  let causes;
  if (process.argv.includes("--classify")) {
    causes = { real: 0, flake: 0, infra: 0, process: 0 };
    for (const run of gates[0].runs.filter((entry) => RED_CONCLUSIONS.has(entry.conclusion))) causes[classifyFailure(failedLog(run.databaseId))] += 1;
  }
  const prs = gh(["pr", "list", "--state", "merged", "--search", `merged:${since.slice(0, 10)}..${until.slice(0, 10)}`, "--limit", "1000", "--json", "number,title,body,mergedAt"]);
  const flaky = summarizeHistory(readHistory(historyPath())).flaky;
  process.stdout.write(formatDigest({ since, until, gates, causes, foundByTally: tallyFoundBy(prs), flaky }));
  if (process.argv.includes("--write-defects")) {
    const all = gh(["pr", "list", "--state", "merged", "--search", "Found by in:body", "--limit", "1000", "--json", "number,title,body,mergedAt"]);
    writeFileSync(DEFECTS_FILE, renderDefects(readFileSync(DEFECTS_FILE, "utf8"), defectRows(all)));
    console.log(`Wrote ${DEFECTS_FILE}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
