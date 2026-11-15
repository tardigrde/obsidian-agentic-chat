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
const KNOWN_ARGS = new Set(["--fix", "--all-worktrees"]);

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
  const raw = execFileSync(
    "git", // NOSONAR:S4036 -- git is a fixed developer binary resolved from PATH; local tooling, not a privileged service.
    ["-C", root, "ls-files", "-z"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
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
  const raw = execFileSync(
    "git", // NOSONAR:S4036 -- git is a fixed developer binary resolved from PATH; local tooling, not a privileged service.
    ["-C", root, "worktree", "list", "--porcelain"],
    { encoding: "utf8" },
  );
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

function parseArgs(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const unknown = args.find((arg) => !KNOWN_ARGS.has(arg));
  if (unknown) return { error: unknown };
  return { help: false, fix: args.includes("--fix"), allWorktrees: args.includes("--all-worktrees") };
}

function printUsageError(message) {
  process.stderr.write(`check-secrets: ${message}\n\n${usage()}`);
  return 2;
}

function scanTrackedFile(file, root, secrets, state) {
  if (skipPath(file)) return;
  const absolute = path.resolve(root, file);
  let info;
  try {
    info = lstatSync(absolute);
  } catch {
    return;
  }
  if (!info.isFile()) return;
  if (isTooLarge(absolute)) {
    process.stdout.write(`SKIP ${file} (over 20 MB)\n`);
    return;
  }
  state.scanned += 1;
  const count = countSecrets(readFileSync(absolute, "utf8"), secrets);
  if (count === 0) return;
  state.leaks += 1;
  process.stdout.write(`LEAK ${file} (${count})\n`);
}

function scanTrackedFiles(root, secrets, state) {
  const tracked = listTracked(root);
  const files = new Set(tracked.map((file) => path.resolve(root, file)));
  for (const file of tracked) scanTrackedFile(file, root, secrets, state);
  return files;
}

function scanLogFile(absolute, secrets, fix, state) {
  if (isTooLarge(absolute)) {
    process.stdout.write(`SKIP ${display(absolute)} (over 20 MB)\n`);
    return;
  }
  state.scanned += 1;
  const text = readFileSync(absolute, "utf8");
  const count = countSecrets(text, secrets);
  if (count === 0) return;
  const shown = display(absolute);
  if (fix) {
    writeFileSync(absolute, redactText(text, secrets));
    state.fixed += 1;
    process.stdout.write(`REDACTED ${shown} (${count})\n`);
    return;
  }
  state.leaks += 1;
  process.stdout.write(`LEAK ${shown} (${count})\n`);
}

function scanLogs(root, allWorktrees, secrets, fix, trackedFiles, state) {
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
      scanLogFile(absolute, secrets, fix, state);
    }
  }
}

function printSummary(state, fix) {
  if (state.leaks > 0) {
    process.stdout.write(
      `secret scan: ${state.leaks} leak(s); ${state.fixed} log file(s) redacted (${state.scanned} files)\n`,
    );
    if (fix) process.stdout.write("tracked files are never edited; fix those leaks by hand\n");
    return 1;
  }
  process.stdout.write(`secret scan: clean (${state.scanned} files, ${state.fixed} log file(s) redacted)\n`);
  return 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (options.error) return printUsageError(`unknown argument: ${options.error}`);

  const root = findRepoRoot();
  const redactor = createRedactor({ root });
  const state = { scanned: 0, leaks: 0, fixed: 0 };
  const trackedFiles = scanTrackedFiles(root, redactor.secrets, state);
  scanLogs(root, options.allWorktrees, redactor.secrets, options.fix, trackedFiles, state);
  return printSummary(state, options.fix);
}

const exitCode = main();
process.exitCode = exitCode;
