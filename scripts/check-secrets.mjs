#!/usr/bin/env node
/**
 * Scan tracked files and ignored logs for secrets.
 *
 * The scanner prints a path and a count, never a value. Tracked files are read
 * only: `--fix` redacts log files in place and leaves a tracked leak for a human
 * to fix. Exit 1 while a leak remains.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRedactor, countSecrets, findRepoRoot, redactText } from "./redact-log.mjs";

const MAX_BYTES = 20 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".obsidian-cache"]);

function usage() {
  return `Usage: node scripts/check-secrets.mjs [--fix] [--all-worktrees]

  Scans tracked files (git ls-files) and logs/ for known key shapes and exact
  values from process.env and .env. Prints LEAK <path> (<n>) or
  REDACTED <path> (<n>).

  --fix             Redact log files in place. Tracked files are never edited.
  --all-worktrees   Also scan logs/ in every git worktree.
`;
}

function skipPath(file) {
  const parts = file.split(/[\\/]/);
  if (parts.some((part) => SKIP_DIRS.has(part))) return true;
  const base = parts.at(-1) ?? "";
  if (base === ".env") return true;
  return base.startsWith(".env.") && base !== ".env.example";
}

function isTooLarge(file) {
  try {
    return statSync(file).size > MAX_BYTES;
  } catch {
    return false;
  }
}

function listTracked(root) {
  const raw = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return raw.toString("utf8").split("\0").filter(Boolean);
}

function walkLogs(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkLogs(file, files);
    } else if (entry.isFile()) {
      if (!skipPath(file)) files.push(file);
    }
  }
}

function worktreePaths(root) {
  const raw = execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  const paths = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length));
  }
  return paths;
}

function display(file) {
  const relative = path.relative(process.cwd(), file);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return path.resolve(file);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return 0;
  }
  const known = new Set(["--fix", "--all-worktrees"]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown) {
    process.stderr.write(`check-secrets: unknown argument: ${unknown}\n\n${usage()}`);
    return 2;
  }

  const fix = args.includes("--fix");
  const allWorktrees = args.includes("--all-worktrees");
  const root = findRepoRoot();
  const redactor = createRedactor({ root });
  let scanned = 0;
  let leaks = 0;
  let fixed = 0;

  const tracked = listTracked(root);
  const trackedFiles = new Set(tracked.map((file) => path.resolve(root, file)));
  for (const file of tracked) {
    if (skipPath(file)) continue;
    const absolute = path.resolve(root, file);
    try {
      if (!lstatSync(absolute).isFile()) continue;
    } catch {
      continue;
    }
    if (isTooLarge(absolute)) {
      process.stdout.write(`SKIP ${file} (over 20 MB)\n`);
      continue;
    }
    scanned += 1;
    const text = readFileSync(absolute, "utf8");
    const count = countSecrets(text, redactor.secrets);
    if (count === 0) continue;
    leaks += 1;
    process.stdout.write(`LEAK ${file} (${count})\n`);
  }

  const trees = allWorktrees ? worktreePaths(root) : [root];
  const seen = new Set();
  for (const tree of trees) {
    const logs = path.join(tree, "logs");
    if (!existsSync(logs)) continue;
    const files = [];
    walkLogs(logs, files);
    for (const file of files) {
      const absolute = path.resolve(file);
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      if (trackedFiles.has(absolute)) continue;
      if (isTooLarge(absolute)) {
        process.stdout.write(`SKIP ${display(absolute)} (over 20 MB)\n`);
        continue;
      }
      scanned += 1;
      const text = readFileSync(absolute, "utf8");
      const count = countSecrets(text, redactor.secrets);
      if (count === 0) continue;
      const shown = display(absolute);
      if (fix) {
        writeFileSync(absolute, redactText(text, redactor.secrets));
        fixed += 1;
        process.stdout.write(`REDACTED ${shown} (${count})\n`);
      } else {
        leaks += 1;
        process.stdout.write(`LEAK ${shown} (${count})\n`);
      }
    }
  }

  if (leaks > 0) {
    process.stdout.write(`secret scan: ${leaks} leak(s); ${fixed} log file(s) redacted (${scanned} files)\n`);
    if (fix) process.stdout.write("tracked files are never edited; fix those leaks by hand\n");
    return 1;
  }
  process.stdout.write(`secret scan: clean (${scanned} files, ${fixed} log file(s) redacted)\n`);
  return 0;
}

const exitCode = main();
process.exitCode = exitCode;
