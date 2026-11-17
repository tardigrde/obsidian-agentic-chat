/**
 * `npm run eval:ab -- --case <ids> [--runs 5] [--base origin/main]` (#392 item 1).
 * Base first, in a temporary detached worktree with the local-only files of
 * `config/worktree-links` symlinked (never copied); then the current tree. The
 * driver ports are fixed, so the two sides never run at the same time.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AB_USAGE, abPlan, formatAbPlan, formatAbTable, parseAbArgs, type AbSide } from "./eval/ab";

async function main(): Promise<void> {
  const args = parseAbArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(AB_USAGE);
    return;
  }
  const headRoot = git(["rev-parse", "--show-toplevel"], process.cwd());
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const plan = abPlan(args, { headRoot, stamp, tmpDir: tmpdir() });
  process.stdout.write(formatAbPlan(plan));
  if (args.dryRun) {
    process.stdout.write("\nDry run: no worktree, no model call.\n");
    return;
  }

  await mkdir(plan.root, { recursive: true });
  git(["worktree", "add", "--detach", plan.baseWorktree, args.base], headRoot);
  try {
    linkLocalFiles(headRoot, plan.baseWorktree);
    const [base, head] = plan.sides;
    const baseCode = await runSide(base);
    const headCode = await runSide(head);
    const baseSummary = readSummary(base);
    const headSummary = readSummary(head);
    process.stdout.write(`\n## eval:ab ${args.base} vs current tree (${args.runs} run(s) per case)\n\n`);
    process.stdout.write(formatAbTable(baseSummary, headSummary));
    process.stdout.write(`\nSummaries: ${base.outDir}/summary.json, ${head.outDir}/summary.json\n`);
    if (baseCode !== 0 || headCode !== 0) {
      process.stderr.write(`eval:ab: a side exited non-zero (base ${baseCode}, head ${headCode}); read its report.\n`);
      process.exitCode = 1;
    }
  } finally {
    try {
      git(["worktree", "remove", "--force", plan.baseWorktree], headRoot);
    } catch (error) {
      process.stderr.write(`eval:ab: could not remove ${plan.baseWorktree}: ${(error as Error).message}\n`);
    }
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync(
    "git", // NOSONAR:S4036 -- git is the repository tool, resolved from PATH like the other scripts.
    args,
    { cwd, encoding: "utf8" },
  ).trim();
}

/** Symlink the names in `config/worktree-links` that exist here. Never copies `.env`. */
function linkLocalFiles(headRoot: string, target: string): void {
  const listFile = path.join(headRoot, "config", "worktree-links");
  if (!existsSync(listFile)) return;
  const names = readFileSync(listFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const name of names) {
    const source = path.join(headRoot, name);
    const destination = path.join(target, name);
    if (!existsSync(source) || existsSync(destination) || isLink(destination)) continue;
    symlinkSync(realpathSync(source), destination);
  }
}

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function runSide(side: AbSide): Promise<number> {
  process.stdout.write(`\n[eval:ab] ${side.label}: ${side.command.join(" ")}\n`);
  return new Promise((resolve) => {
    const [command, ...rest] = side.command;
    const child = spawn(command === "node" ? process.execPath : command, rest, { cwd: side.cwd, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      process.stderr.write(`eval:ab: ${side.label} did not start: ${error.message}\n`);
      resolve(1);
    });
  });
}

function readSummary(side: AbSide): unknown {
  const file = path.join(side.outDir, "summary.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { cases: [] };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
