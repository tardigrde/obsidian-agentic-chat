#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Diff coverage: of the `src/` lines this change adds or edits, how many does
 * the unit suite run? Printed, never enforced (#393 T18, D18). It reads the
 * Istanbul-format `coverage/coverage-final.json` that `vitest --coverage`
 * writes and the zero-context diff against a base.
 *
 *   node scripts/diff-coverage.mjs --base origin/main [--markdown]
 *
 * In CI on a pull request the checkout is the merge commit, so `--base HEAD^1`
 * is the PR's base and the diff is exactly the PR.
 */

const COVERAGE_FILE = path.join("coverage", "coverage-final.json");

/** Changed new-side line numbers per file, from `git diff --unified=0`. */
export function parseUnifiedDiff(text) {
  const changed = new Map();
  let file = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (file && !changed.has(file)) changed.set(file, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let offset = 0; offset < count; offset += 1) changed.get(file).add(start + offset);
    }
  }
  for (const [name, lines] of changed) if (lines.size === 0) changed.delete(name);
  return changed;
}

/** Executable lines and whether any statement on each ran, from one Istanbul file entry. */
function lineHits(entry) {
  const hits = new Map();
  for (const [id, location] of Object.entries(entry.statementMap ?? {})) {
    const count = entry.s?.[id] ?? 0;
    for (let line = location.start.line; line <= location.end.line; line += 1) {
      hits.set(line, (hits.get(line) ?? 0) + count);
    }
  }
  return hits;
}

/**
 * Rows per changed source file: changed executable lines, how many ran, and
 * the uncovered line numbers. A changed file that is missing from the coverage
 * map was never loaded by a unit test; its row says so (its executable lines
 * are unknown, so it does not count toward the percentage).
 */
export function diffCoverage(changed, coverage, root = process.cwd()) {
  const byFile = new Map();
  for (const [absolute, entry] of Object.entries(coverage)) {
    byFile.set(path.relative(root, entry.path ?? absolute).replaceAll("\\", "/"), entry);
  }
  const rows = [];
  for (const [file, lines] of changed) {
    if (!file.startsWith("src/") || !/\.(ts|tsx|js|mjs)$/.test(file)) continue;
    const entry = byFile.get(file);
    if (!entry) {
      rows.push({ file, executable: null, covered: 0, uncovered: [...lines].sort((a, b) => a - b), loaded: false });
      continue;
    }
    const hits = lineHits(entry);
    const executable = [...lines].filter((line) => hits.has(line)).sort((a, b) => a - b);
    const uncovered = executable.filter((line) => (hits.get(line) ?? 0) === 0);
    rows.push({ file, executable: executable.length, covered: executable.length - uncovered.length, uncovered, loaded: true });
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}

function ranges(lines) {
  const out = [];
  for (const line of lines) {
    const last = out.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else out.push([line, line]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

export function formatDiffCoverage(rows, { markdown = false } = {}) {
  const measured = rows.filter((row) => row.loaded);
  const executable = measured.reduce((sum, row) => sum + row.executable, 0);
  const covered = measured.reduce((sum, row) => sum + row.covered, 0);
  const pct = executable === 0 ? null : Math.round((covered / executable) * 1000) / 10;
  const total = pct === null ? "no changed executable src/ lines" : `${pct}% (${covered}/${executable} changed lines)`;
  if (!markdown) {
    const body = rows.map((row) =>
      row.loaded
        ? `  ${row.file}: ${row.covered}/${row.executable}${row.uncovered.length ? ` uncovered ${ranges(row.uncovered)}` : ""}`
        : `  ${row.file}: not loaded by any unit test`,
    );
    return [`diff coverage: ${total}`, ...body].join("\n") + "\n";
  }
  const lines = ["## Diff coverage (changed `src/` lines, advisory)", "", `**${total}**`, ""];
  if (rows.length > 0) {
    lines.push("| File | Covered | Uncovered lines |", "|---|---|---|");
    for (const row of rows) {
      lines.push(
        row.loaded
          ? `| \`${row.file}\` | ${row.covered}/${row.executable} | ${row.uncovered.length ? ranges(row.uncovered) : "-"} |`
          : `| \`${row.file}\` | not loaded by a unit test | - |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function main(argv) {
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : "origin/main";
  const markdown = argv.includes("--markdown");
  if (!existsSync(COVERAGE_FILE)) {
    process.stdout.write(`diff coverage: no ${COVERAGE_FILE}; run \`npm run verify -- check --coverage\` first\n`);
    return 0;
  }
  const range = base.includes("...") || base.includes("..") ? base : `${base}...HEAD`;
  // The merge-commit form (HEAD^1) has no merge base with HEAD's first parent; diff the two trees.
  const args = base.startsWith("HEAD^") ? ["diff", "--unified=0", base, "HEAD", "--", "src"] : ["diff", "--unified=0", range, "--", "src"];
  const diff = spawnSync("git", args, { encoding: "utf8" }); // NOSONAR:S4036 -- git from PATH.
  if (diff.status !== 0) {
    process.stdout.write(`diff coverage: git diff failed (${diff.stderr.trim()}); skipped\n`);
    return 0;
  }
  const coverage = JSON.parse(readFileSync(COVERAGE_FILE, "utf8"));
  process.stdout.write(formatDiffCoverage(diffCoverage(parseUnifiedDiff(diff.stdout), coverage), { markdown }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
