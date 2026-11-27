#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the report and its artifact paths. */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * The CRAP report (Change Risk Anti-Patterns): complexity plus coverage per
 * function, sorted worst first. It is advisory: `crap-ts` runs with
 * `reportOnly` so a risky function never blocks a merge. The Markdown and JSON
 * files land in `coverage/`, next to the coverage input CI already uploads.
 *
 * `max` is 30, the Crap4J guideline: above it, add tests or simplify.
 */
const REPORT_DIR = "coverage";
const MARKDOWN_FILE = path.join(REPORT_DIR, "crap.md");
const JSON_FILE = path.join(REPORT_DIR, "crap.json");
const DEFAULT_LIMIT = 30;
const GUIDELINE = 30;

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("`", "\\`");
}

function percent(value) {
  return `${Number.isFinite(value) ? value.toFixed(1) : "0.0"}%`;
}

function score(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

/**
 * Format a `crap-ts --json` report as the PR/summary Markdown. The full JSON
 * stays the source of truth; this is the short read for a human.
 */
export function formatCrapMarkdown(report, { limit = DEFAULT_LIMIT, maxScore = GUIDELINE } = {}) {
  const summary = report.summary ?? {};
  const functions = [...(report.functions ?? [])].sort((a, b) => (b.crap ?? 0) - (a.crap ?? 0));
  const rows = functions.slice(0, limit);
  const lines = [
    "## CRAP report",
    "",
    `${summary.functions ?? functions.length} functions across ${summary.files ?? "?"} files; ` +
      `${summary.aboveMax ?? functions.filter((entry) => entry.level === "fail").length} above the CRAP ${maxScore} guideline. ` +
      "Advisory: this report does not gate the build.",
    "",
  ];

  if (rows.length === 0) {
    lines.push("No function matched the configured minimum size.", "");
  } else {
    lines.push(
      `Worst ${rows.length} function(s) by CRAP score:`,
      "",
      "| CRAP | Complexity | Coverage | Function | Location |",
      "|---:|---:|---:|---|---|",
    );
    for (const entry of rows) {
      const name = entry.name || "<anonymous>";
      lines.push(
        `| ${score(entry.crap)} | ${entry.complexity} | ${percent(entry.coverage)} | ` +
          `\`${escapeCell(name)}\` | \`${escapeCell(entry.file)}:${entry.line}\` |`,
      );
    }
    lines.push("");
  }

  const missing = report.missingFiles ?? [];
  if (missing.length > 0) {
    lines.push(
      `Missing coverage evidence (${missing.length}): ${missing.map((file) => `\`${escapeCell(file)}\``).join(", ")}`,
      "",
    );
  }
  lines.push(`Full JSON: \`${JSON_FILE}\``, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * GitHub Actions gives every step a file in `GITHUB_STEP_SUMMARY`. Appending
 * here keeps the report on the job page without a workflow-only step.
 */
export function appendStepSummary(markdown, file = process.env.GITHUB_STEP_SUMMARY) {
  if (!file) return false;
  appendFileSync(file, markdown);
  return true;
}

function crapCli() {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("crap-ts")), "cli.js");
}

/**
 * The lane runs this script without `--strict`: a broken report must not stop
 * `verify -- check` before the witness self-test. `npm run crap` passes
 * `--strict`, so a developer sees the failure.
 */
function reportError(message) {
  console.error(message);
  if (process.argv.includes("--strict")) {
    process.exitCode = 1;
  } else {
    console.error("crap: report skipped (advisory); run `npm run crap` to fail on this error.");
  }
}

function main() {
  const coverageFile = path.resolve("coverage", "coverage-final.json");
  if (!existsSync(coverageFile)) {
    reportError(
      `crap: missing ${path.relative(process.cwd(), coverageFile)}; run \`npm run test:coverage\` first.`,
    );
    return;
  }

  const result = spawnSync(process.execPath, [crapCli(), "score", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    reportError(`crap: crap-ts exited ${result.status ?? "without a status"}.`);
    return;
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    reportError(`crap: could not parse crap-ts JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(JSON_FILE, `${JSON.stringify(report, null, 2)}\n`);
    const markdown = formatCrapMarkdown(report);
    writeFileSync(MARKDOWN_FILE, markdown);
    process.stdout.write(markdown);
    if (appendStepSummary(markdown)) console.log("crap: appended to GITHUB_STEP_SUMMARY");
    console.log(`crap: wrote ${MARKDOWN_FILE} and ${JSON_FILE}`);
  } catch (error) {
    reportError(`crap: could not write the report: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
