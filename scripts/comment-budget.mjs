#!/usr/bin/env node
import process from "node:process";
import { collectComments, compareWithBase } from "./lib/comments.mjs";

const MAX_DETAILED_WARNINGS = 20;

function usage() {
  return `Usage: node scripts/comment-budget.mjs [--base <ref>] [--list] [--json] [--strict]

  (default)   warn when a changed file has more code comments than at the base
              branch; always exits 0
  --base REF  compare with the merge base of REF (default: origin/main, then main)
  --list      print every file with its comment count
  --json      print the comparison as JSON (still exits 0)
  --strict    exit 1 when comments were added (local use only; CI warns)

Only a net increase in a file warns. Deleting or rewording a comment is free.
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
  process.stdout.write(`::warning file=${escapeProperty(file)},line=${line},title=New code comment::${escapeData(message)}\n`);
}

function baseCandidates(args) {
  const flag = args.indexOf("--base");
  const explicit = flag === -1 ? undefined : args[flag + 1];
  const pullRequest = process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_EVENT_NAME === "pull_request";
  // A pull request checkout is a merge commit: its first parent is the base branch tip.
  return [explicit, process.env.COMMENT_BASE_REF, pullRequest ? "HEAD^1" : undefined, "origin/main", "main"];
}

function printComparison(result) {
  const { additions, currentTotal, baseTotal, base } = result;
  if (additions.length === 0) {
    process.stdout.write(`Comments OK: no file gained comments since ${base.ref} (changed files: ${baseTotal} -> ${currentTotal}).\n`);
    return;
  }
  const added = additions.reduce((sum, entry) => sum + entry.added, 0);
  process.stdout.write(
    `Comments: ${added} more in ${additions.length} file${additions.length === 1 ? "" : "s"} than at ${base.ref}.\n`,
  );
  let printed = 0;
  for (const entry of additions) {
    process.stdout.write(`  ${entry.file}: ${entry.base} -> ${entry.current}\n`);
    for (const comment of entry.newComments) {
      if (printed >= MAX_DETAILED_WARNINGS) continue;
      const firstLine = comment.raw.split("\n")[0].trim().slice(0, 120);
      process.stdout.write(`    ${entry.file}:${comment.line}  ${firstLine}\n`);
      annotation(entry.file, comment.line, "New code comment. Keep it only if it guards an invariant; see docs/development/comments.md.");
      printed += 1;
    }
  }
  if (printed < added) process.stdout.write(`  ... ${added - printed} more\n`);
  process.stdout.write("Warn only: delete the comment, or move the rationale to docs/adr.\n");
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
  if (args.includes("--list")) {
    listFiles(collectComments(process.cwd()));
    return;
  }
  const result = compareWithBase(baseCandidates(args));
  if (!result) {
    process.stdout.write("Comment check skipped: no base branch found. Fetch origin/main or pass --base <ref>.\n");
    return;
  }
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  printComparison(result);
  if (args.includes("--strict") && result.additions.length > 0) process.exitCode = 1;
}

main(process.argv.slice(2));
