#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyEnvFile } from "./live-env.mjs";

const MANIFEST_NAME = "worktree-links";
const RECENT_MS = 3 * 24 * 60 * 60 * 1000;

const USAGE = `Usage:
  worktree.mjs new <name> [--base <ref>] [--path <dir>] [--branch <branch>] [--json]
  worktree.mjs env [--env-file <path>] [--] <command...>
  worktree.mjs list [--json]
  worktree.mjs cleanup [--dry-run] [--apply] [--force] [--base <ref>] [--json]
  worktree.mjs --self-test

Cleanup defaults to a dry run. --apply removes only safe worktrees. --force is a
human-only override that also prints every path it removes.
`;

function git(args, options = {}) {
  const result = spawnSync("git", args, { // NOSONAR:S4036 — git is a fixed developer binary resolved from the user's PATH; this helper is not a privileged service.
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  return result;
}

function gitOrThrow(args, options = {}) {
  const result = git(args, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function lexists(target) {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function takeFlag(args, name) {
  const rest = [];
  let present = false;
  for (const arg of args) {
    if (arg === name) present = true;
    else rest.push(arg);
  }
  return { present, rest };
}

function takeOption(args, name) {
  const rest = [];
  let value;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value`);
      value = next;
      index += 1;
    } else if (arg.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1);
      if (!value) throw new Error(`${name} needs a value`);
    } else {
      rest.push(arg);
    }
  }
  return { value, rest };
}

function slugify(name) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[-.]{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!slug) throw new Error("name must contain a letter or digit");
  return slug;
}

/**
 * Classify a worktree for cleanup.
 * @param {{
 *   trackedChanges?: number,
 *   untrackedChanges?: number,
 *   prState?: "OPEN"|"MERGED"|"CLOSED"|null,
 *   merged?: boolean,
 *   recent?: boolean,
 * }} [input]
 * @returns {"hold-wip"|"hold-scratch"|"hold-open-pr"|"safe"|"recent"|"review"}
 */
export function classifyWorktree({
  trackedChanges = 0,
  untrackedChanges = 0,
  prState = null,
  merged = false,
  recent = false,
} = {}) {
  if (trackedChanges > 0) return "hold-wip";
  if (untrackedChanges > 0) return "hold-scratch";
  if (prState === "OPEN") return "hold-open-pr";
  if (prState === "MERGED" || merged) return "safe";
  if (recent) return "recent";
  return "review";
}

function parseWorktreePorcelain(output) {
  const worktrees = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ") && current) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached" && current) {
      current.detached = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function readWorktrees(cwd) {
  return parseWorktreePorcelain(gitOrThrow(["worktree", "list", "--porcelain"], { cwd }).stdout);
}

function readWorktreeLinks(root) {
  const manifestPath = path.join(root, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    process.stderr.write(`warning: no ${MANIFEST_NAME} at ${manifestPath}; linking nothing\n`);
    return [];
  }
  const links = [];
  for (const rawLine of readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (path.isAbsolute(line) || normalized === "." || segments.includes("..")) continue;
    if (normalized === ".git" || normalized.startsWith(".git/")) continue;
    links.push(normalized);
  }
  return links;
}

function linkManifestEntries(mainRoot, targetRoot) {
  const linked = [];
  const skipped = [];
  const missing = [];
  for (const entry of readWorktreeLinks(mainRoot)) {
    const source = path.join(mainRoot, entry);
    const target = path.join(targetRoot, entry);
    if (!lexists(source)) {
      missing.push(entry);
      continue;
    }
    if (lexists(target)) {
      skipped.push(entry);
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    const type = process.platform === "win32" && statSync(source).isDirectory() ? "junction" : undefined;
    symlinkSync(source, target, type);
    linked.push(entry);
  }
  return { linked, skipped, missing };
}

function removeManifestSymlinks(mainRoot, worktreePath) {
  const unlinked = [];
  for (const entry of readWorktreeLinks(mainRoot)) {
    const target = path.join(worktreePath, entry);
    try {
      if (lstatSync(target).isSymbolicLink()) {
        unlinkSync(target);
        unlinked.push(entry);
      }
    } catch {
      // The link is already gone.
    }
  }
  return unlinked;
}

function defaultBase(cwd, worktrees) {
  for (const candidate of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { cwd }).status === 0) {
      return candidate;
    }
  }
  return worktrees[0]?.branch || "HEAD";
}

function readStatus(worktreePath) {
  const result = git(["status", "--porcelain"], { cwd: worktreePath });
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || result.stdout).trim() || "git status failed",
      trackedChanges: 0,
      untrackedChanges: 0,
      dirty: null,
    };
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const untrackedChanges = lines.filter((line) => line.startsWith("?? ")).length;
  const trackedChanges = lines.length - untrackedChanges;
  return { ok: true, trackedChanges, untrackedChanges, dirty: lines.length > 0 };
}

function readTracking(worktreePath) {
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
    cwd: worktreePath,
  });
  if (upstream.status !== 0 || !upstream.stdout.trim()) {
    return { upstream: null, ahead: null, behind: null };
  }
  const ref = upstream.stdout.trim();
  const counts = git(["rev-list", "--left-right", "--count", `HEAD...${ref}`], { cwd: worktreePath });
  if (counts.status !== 0) return { upstream: ref, ahead: null, behind: null };
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  return { upstream: ref, ahead, behind };
}

function newestMtime(worktreePath) {
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: worktreePath,
  });
  let newest = 0;
  if (listed.status === 0) {
    for (const file of listed.stdout.split("\0")) {
      if (!file) continue;
      try {
        const stats = lstatSync(path.join(worktreePath, file));
        if (stats.isFile()) newest = Math.max(newest, stats.mtimeMs);
      } catch {
        // The file vanished between listing and stat.
      }
    }
  }
  if (newest === 0) {
    try {
      newest = statSync(worktreePath).mtimeMs;
    } catch {
      newest = 0;
    }
  }
  return newest;
}

function isMerged(worktreePath, base) {
  return git(["merge-base", "--is-ancestor", "HEAD", base], { cwd: worktreePath }).status === 0;
}

function hasGh() {
  const result = spawnSync("gh", ["--version"], { encoding: "utf8" }); // NOSONAR:S4036 — gh is a fixed developer binary resolved from the user's PATH; this helper is not a privileged service.
  return !result.error && result.status === 0;
}

function lookupPr(worktreePath, branch, ghAvailable) {
  if (!ghAvailable || !branch || branch.startsWith("(")) return { pr: null, skipped: false };
  const result = spawnSync(
    "gh", // NOSONAR:S4036 — gh is a fixed developer binary resolved from the user's PATH; this helper is not a privileged service.
    ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,isDraft", "--limit", "1"],
    { cwd: worktreePath, encoding: "utf8" },
  );
  if (result.error || result.status !== 0) return { pr: null, skipped: true };
  try {
    const [pr] = JSON.parse(result.stdout);
    if (!pr) return { pr: null, skipped: false };
    return {
      pr: { number: pr.number, state: pr.state, isDraft: Boolean(pr.isDraft) },
      skipped: false,
    };
  } catch {
    return { pr: null, skipped: true };
  }
}

function describeForList(worktree) {
  const branch = worktree.branch || "(detached)";
  const status = readStatus(worktree.path);
  const tracking = readTracking(worktree.path);
  const mtime = newestMtime(worktree.path);
  return {
    path: worktree.path,
    branch,
    head: worktree.head ?? null,
    dirty: status.dirty,
    ahead: tracking.ahead,
    behind: tracking.behind,
    upstream: tracking.upstream,
    lastMtime: mtime > 0 ? new Date(mtime).toISOString() : null,
  };
}

function formatList(values) {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function printTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)),
  );
  const formatRow = (row) =>
    row
      .map((cell, index) => String(cell ?? "").padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  process.stdout.write([formatRow(headers), ...rows.map(formatRow)].join("\n") + "\n");
}

function formatPr(pr) {
  if (!pr) return "-";
  const state = pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase();
  return `#${pr.number} ${state}`;
}

function formatAheadBehind(entry) {
  if (entry.ahead === null || entry.behind === null) return "-";
  return `${entry.ahead}/${entry.behind}`;
}

function shortHead(head) {
  return head ? head.slice(0, 7) : "-";
}

function shortMtime(value) {
  return value ?? "-";
}

function newCommand(argv) {
  let args = [...argv];
  const jsonFlag = takeFlag(args, "--json");
  args = jsonFlag.rest;
  const baseOption = takeOption(args, "--base");
  args = baseOption.rest;
  const pathOption = takeOption(args, "--path");
  args = pathOption.rest;
  const branchOption = takeOption(args, "--branch");
  args = branchOption.rest;
  if (args.length !== 1) throw new Error(`new needs exactly one name\n\n${USAGE}`);

  const cwd = process.cwd();
  const slug = slugify(args[0]);
  const repoRoot = gitOrThrow(["rev-parse", "--show-toplevel"], { cwd }).stdout.trim();
  const worktrees = readWorktrees(cwd);
  const mainRoot = worktrees[0]?.path ?? repoRoot;
  const base = baseOption.value || defaultBase(cwd, worktrees);
  const branch = branchOption.value || `wt/${slug}`;
  const target = pathOption.value
    ? path.resolve(cwd, pathOption.value)
    : path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-worktrees`, slug);

  if (lexists(target)) throw new Error(`target already exists: ${target}`);

  const result = git(["worktree", "add", "-b", branch, target, base], { cwd: repoRoot });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`git worktree add failed${detail ? `: ${detail}` : ""}`);
  }

  const { linked, skipped, missing } = linkManifestEntries(mainRoot, target);
  const summary = { path: target, branch, base, linked, skipped, missing };
  if (jsonFlag.present) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `path     ${target}`,
        `branch   ${branch}`,
        `base     ${base}`,
        `linked   ${formatList(linked)}`,
        `skipped  ${formatList(skipped)}`,
        ...(missing.length > 0 ? [`missing  ${formatList(missing)}`] : []),
      ].join("\n") + "\n",
    );
  }
  return 0;
}

function envCommand(argv) {
  let envFile;
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "--env-file") {
      envFile = argv[index + 1];
      if (!envFile) throw new Error("--env-file needs a value");
      index += 1;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      envFile = arg.slice("--env-file=".length);
      if (!envFile) throw new Error("--env-file needs a value");
      continue;
    }
    break;
  }
  const command = argv.slice(index);
  if (command.length === 0) {
    throw new Error(`env needs a command, for example: worktree.mjs env -- node -e "..."`);
  }

  const cwd = process.cwd();
  const envPath = envFile ? path.resolve(cwd, envFile) : path.join(cwd, ".env");
  if (existsSync(envPath)) {
    applyEnvFile(envPath, process.env);
  } else if (envFile) {
    throw new Error(`env file not found: ${envPath}`);
  } else {
    process.stderr.write(`warning: no .env at ${envPath}; running with the current environment\n`);
  }

  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function listCommand(argv) {
  let args = [...argv];
  const jsonFlag = takeFlag(args, "--json");
  args = jsonFlag.rest;
  if (args.length > 0) throw new Error(`list does not take arguments: ${args.join(" ")}`);

  const worktrees = readWorktrees(process.cwd()).map(describeForList);
  if (jsonFlag.present) {
    process.stdout.write(`${JSON.stringify({ worktrees }, null, 2)}\n`);
    return 0;
  }

  printTable(
    ["PATH", "BRANCH", "HEAD", "DIRTY", "AHEAD/BEHIND", "LAST MTIME"],
    worktrees.map((entry) => [
      entry.path,
      entry.branch,
      shortHead(entry.head),
      entry.dirty === null ? "?" : entry.dirty ? "dirty" : "clean",
      formatAheadBehind(entry),
      shortMtime(entry.lastMtime),
    ]),
  );
  return 0;
}

function cleanupEntry(worktree, base, ghAvailable, force, apply) {
  const branch = worktree.branch || "(detached)";
  const status = readStatus(worktree.path);
  const { pr, skipped: ghSkipped } = lookupPr(worktree.path, branch, ghAvailable);
  const merged = status.ok && isMerged(worktree.path, base);
  const mtime = newestMtime(worktree.path);
  const recent = mtime > 0 && Date.now() - mtime <= RECENT_MS;
  const bucket = status.ok
    ? classifyWorktree({
        trackedChanges: status.trackedChanges,
        untrackedChanges: status.untrackedChanges,
        prState: pr?.state ?? null,
        merged,
        recent,
      })
    : "review";
  const removable = bucket === "safe" || force;
  const action = removable ? (apply ? "remove" : "would-remove") : "keep";

  return {
    path: worktree.path,
    branch,
    head: worktree.head ?? null,
    bucket,
    merged,
    pr,
    ghSkipped,
    dirty: { tracked: status.trackedChanges, untracked: status.untrackedChanges },
    lastMtime: mtime > 0 ? new Date(mtime).toISOString() : null,
    action,
    forced: force && bucket !== "safe",
    ...(status.ok ? {} : { error: status.error }),
  };
}

function removeWorktree(mainRoot, entry, force) {
  if (!lexists(entry.path)) {
    git(["worktree", "prune"], { cwd: mainRoot });
    return { ok: true, unlinked: [] };
  }

  const unlinked = removeManifestSymlinks(mainRoot, entry.path);
  const removal = git(["worktree", "remove", entry.path], { cwd: mainRoot });
  if (removal.status === 0) {
    git(["worktree", "prune"], { cwd: mainRoot });
    return { ok: true, unlinked };
  }

  const status = readStatus(entry.path);
  const clean = status.ok && status.trackedChanges === 0 && status.untrackedChanges === 0;
  if (force || clean) {
    rmSync(entry.path, { recursive: true, force: true });
    git(["worktree", "prune"], { cwd: mainRoot });
    if (!lexists(entry.path)) return { ok: true, unlinked };
    return { ok: false, unlinked, error: "directory still exists after rm -rf" };
  }

  const detail = (removal.stderr || removal.stdout).trim();
  return { ok: false, unlinked, error: detail || "git worktree remove failed" };
}

function cleanupCommand(argv) {
  let args = [...argv];
  const jsonFlag = takeFlag(args, "--json");
  args = jsonFlag.rest;
  const dryRunFlag = takeFlag(args, "--dry-run");
  args = dryRunFlag.rest;
  const applyFlag = takeFlag(args, "--apply");
  args = applyFlag.rest;
  const forceFlag = takeFlag(args, "--force");
  args = forceFlag.rest;
  const baseOption = takeOption(args, "--base");
  args = baseOption.rest;
  if (args.length > 0) throw new Error(`cleanup does not take arguments: ${args.join(" ")}`);
  if (dryRunFlag.present && applyFlag.present) {
    throw new Error("use either --dry-run or --apply, not both");
  }

  const apply = applyFlag.present;
  const force = forceFlag.present;
  const cwd = process.cwd();
  const worktrees = readWorktrees(cwd);
  if (worktrees.length === 0) throw new Error("no worktrees found");
  const mainRoot = worktrees[0].path;
  const base = baseOption.value || defaultBase(cwd, worktrees);
  const ghAvailable = hasGh();
  const entries = worktrees
    .slice(1)
    .filter((worktree) => path.resolve(worktree.path) !== path.resolve(mainRoot))
    .map((worktree) => cleanupEntry(worktree, base, ghAvailable, force, apply));

  const candidates = entries.filter((entry) => entry.action === "remove");
  if (apply && !jsonFlag.present) {
    for (const entry of candidates) {
      process.stdout.write(
        `${entry.forced ? "FORCE removing" : "removing"} ${entry.path} (${entry.bucket})\n`,
      );
    }
  }

  const removed = [];
  const failed = [];
  if (apply) {
    for (const entry of candidates) {
      const result = removeWorktree(mainRoot, entry, force);
      if (result.ok) removed.push(entry.path);
      else failed.push({ path: entry.path, error: result.error });
    }
  }

  if (jsonFlag.present) {
    process.stdout.write(
      `${JSON.stringify({ base, dryRun: !apply, force, worktrees: entries, removed, failed }, null, 2)}\n`,
    );
  } else {
    printTable(
      ["PATH", "BRANCH", "BUCKET", "DIRTY", "PR", "LAST MTIME", "ACTION"],
      entries.map((entry) => [
        entry.path,
        entry.branch,
        entry.bucket,
        entry.error ? "?" : entry.dirty.tracked > 0 ? "wip" : entry.dirty.untracked > 0 ? "scratch" : "clean",
        formatPr(entry.pr),
        shortMtime(entry.lastMtime),
        entry.forced ? `${entry.action} (force)` : entry.action,
      ]),
    );
    if (failed.length > 0) {
      process.stderr.write(`failed to remove ${failed.length} worktree(s)\n`);
    }
  }
  return failed.length > 0 ? 1 : 0;
}

function runNode(scriptPath, args, cwd, env) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`self-test command failed: ${args.join(" ")}${detail ? `\n${detail}` : ""}`);
  }
  return result;
}

function selfTest() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "agentic-chat-worktree-"));
  try {
    const repo = path.join(tempRoot, "repo");
    mkdirSync(repo);
    gitOrThrow(["init", "-q", "-b", "main"], { cwd: repo });
    gitOrThrow(["config", "user.email", "self-test@example.invalid"], { cwd: repo });
    gitOrThrow(["config", "user.name", "Worktree Self Test"], { cwd: repo });
    writeFileSync(path.join(repo, "README.md"), "# worktree self-test\n");
    writeFileSync(path.join(repo, ".gitignore"), ".env\nnode_modules/\n");
    writeFileSync(path.join(repo, ".env"), "WT_HELPER_SELF_TEST_VALUE=fake-self-test-value\n");
    writeFileSync(path.join(repo, MANIFEST_NAME), ".env\n");
    gitOrThrow(["add", "README.md", ".gitignore", MANIFEST_NAME], { cwd: repo });
    gitOrThrow(["commit", "-q", "-m", "init"], { cwd: repo });

    const scriptPath = fileURLToPath(import.meta.url);
    const childEnv = { ...process.env };
    delete childEnv.WT_HELPER_SELF_TEST_VALUE;

    const created = JSON.parse(
      runNode(scriptPath, ["new", "self-test", "--json"], repo, childEnv).stdout,
    );
    assert.ok(existsSync(created.path), "new did not create the worktree directory");
    assert.ok(created.linked.includes(".env"), "new did not link .env");
    assert.ok(
      lstatSync(path.join(created.path, ".env")).isSymbolicLink(),
      ".env must be a symlink, not a copy",
    );

    const envResult = runNode(
      scriptPath,
      ["env", "--", "node", "-e", "process.stdout.write(process.env.WT_HELPER_SELF_TEST_VALUE ?? '')"],
      created.path,
      childEnv,
    );
    assert.equal(
      envResult.stdout,
      "fake-self-test-value",
      "env did not expose the fake self-test value to the child",
    );

    assert.equal(
      gitOrThrow(["status", "--porcelain"], { cwd: created.path }).stdout.trim(),
      "",
      "self-test worktree must be clean before cleanup",
    );
    assert.equal(
      git(["merge-base", "--is-ancestor", "HEAD", "main"], { cwd: created.path }).status,
      0,
      "self-test worktree must be merged into main",
    );

    const dryRun = JSON.parse(
      runNode(scriptPath, ["cleanup", "--dry-run", "--json"], repo, childEnv).stdout,
    );
    const dryEntry = dryRun.worktrees.find(
      (entry) => path.resolve(entry.path) === path.resolve(created.path),
    );
    assert.ok(dryEntry, "cleanup dry-run did not classify the new worktree");
    assert.ok(dryEntry.bucket, "cleanup dry-run produced no bucket");
    assert.ok(existsSync(created.path), "cleanup dry-run must not delete the worktree");
    assert.deepEqual(dryRun.removed, [], "cleanup dry-run must not remove anything");

    const applied = JSON.parse(
      runNode(scriptPath, ["cleanup", "--apply", "--json"], repo, childEnv).stdout,
    );
    assert.ok(
      applied.removed.some((entry) => path.resolve(entry) === path.resolve(created.path)),
      "cleanup --apply did not remove the worktree",
    );
    assert.equal(existsSync(created.path), false, "cleanup --apply left the directory behind");

    process.stdout.write("SELF-TEST PASS\n");
    return 0;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "--self-test") return selfTest();
  switch (command) {
    case "new":
      return newCommand(rest);
    case "env":
      return envCommand(rest);
    case "list":
      return listCommand(rest);
    case "cleanup":
      return cleanupCommand(rest);
    default:
      throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}

const directRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (directRun) {
  try {
    const code = main(process.argv.slice(2));
    if (code !== undefined) process.exitCode = code;
  } catch (error) {
    process.stderr.write(`worktree: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
