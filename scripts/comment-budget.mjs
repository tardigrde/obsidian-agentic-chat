#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  BASELINE_PATH,
  baselineFrom,
  compareBudget,
  collectComments,
  readBaseline,
} from "./lib/comments.mjs";

const MAX_DETAILED_WARNINGS = 20;

function usage() {
  return `Usage: node scripts/comment-budget.mjs [--update|--list|--json|--strict]

  (default)   warn about comments above the per-file ratchet; always exits 0
  --update    rewrite config/comment-baseline.json from the current tree
  --list      print every file with its comment count
  --json      print the comparison as JSON (still exits 0)
  --strict    exit 1 when the budget is exceeded (local use only; CI warns)

The ratchet freezes today's comments per file. Deleting comments never fails;
adding one above a file's frozen count prints a warning. After deleting, run
--update so the lower count becomes the new floor.
`;
}

function escapeData(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function annotation(file, line, message) {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  process.stdout.write(`::warning file=${escapeProperty(file)},line=${line},title=Comment budget::${escapeData(message)}\n`);
}

function printComparison(comparison) {
  const { additions, currentTotal, baselineTotal } = comparison;
  if (additions.length === 0) {
    process.stdout.write(`Comment budget OK: ${currentTotal} comments (baseline ${baselineTotal}).\n`);
    return;
  }
  const added = additions.reduce((sum, entry) => sum + (entry.current - entry.baseline), 0);
  process.stdout.write(
    `Comment budget: ${added} new comment${added === 1 ? "" : "s"} in ${additions.length} file${
      additions.length === 1 ? "" : "s"
    } (baseline ${baselineTotal}, now ${currentTotal}).\n`,
  );
  let printed = 0;
  for (const entry of additions) {
    process.stdout.write(`  ${entry.file}: ${entry.baseline} -> ${entry.current}\n`);
    for (const comment of entry.newComments) {
      if (printed >= MAX_DETAILED_WARNINGS) continue;
      const firstLine = comment.raw.split("\n")[0].trim().slice(0, 120);
      process.stdout.write(`    ${entry.file}:${comment.line}  ${firstLine}\n`);
      annotation(entry.file, comment.line, "New code comment above the ratchet. Delete it or move the rationale to an ADR.");
      printed += 1;
    }
  }
  if (printed < added) process.stdout.write(`  ... ${added - printed} more\n`);
  process.stdout.write("Warn only: run `npm run lint:comments -- --update` after deleting comments to ratchet the floor down.\n");
}

function updateBaseline(commentsByFile) {
  const baseline = baselineFrom(commentsByFile);
  const target = path.join(process.cwd(), BASELINE_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(`Wrote ${BASELINE_PATH}: ${baseline.total} comments in ${Object.keys(baseline.files).length} files.\n`);
}

function listFiles(commentsByFile) {
  const rows = [...commentsByFile]
    .map(([file, comments]) => ({ file, count: comments.length }))
    .filter((row) => row.count > 0)
    .sort((left, right) => right.count - left.count || left.file.localeCompare(right.file));
  for (const row of rows) process.stdout.write(`${String(row.count).padStart(5)}  ${row.file}\n`);
  process.stdout.write(`${String(rows.reduce((sum, row) => sum + row.count, 0)).padStart(5)}  total (${rows.length} files)\n`);
}

function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const commentsByFile = collectComments(process.cwd());
  if (args.includes("--update")) {
    updateBaseline(commentsByFile);
    return;
  }
  if (args.includes("--list")) {
    listFiles(commentsByFile);
    return;
  }
  const comparison = compareBudget(commentsByFile, readBaseline(path.join(process.cwd(), BASELINE_PATH)));
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    return;
  }
  printComparison(comparison);
  if (args.includes("--strict") && comparison.additions.length > 0) process.exitCode = 1;
}

main(process.argv.slice(2));
