#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createLineRedactor, createRedactor } from "./redact-log.mjs";
import { LANE_NAMES, RETIRED_LANES, lanes, usage } from "./verify-lanes.mjs";
import { appendHistory, buildRunResult, gitInfo, parseVitestJson } from "./lib/run-result.mjs";

// Read process.env and .env once. Every child line passes through this.
const REDACTOR = createRedactor();

function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key === "INIT_CWD") delete env[key];
  }
  return { ...env, ...extra };
}

function runStep(s) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let settled = false;
    let timedOut = false;

    const child = spawn(s.command, s.args, {
      env: childEnv(s.env),
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ...s,
        code: timedOut ? 124 : code ?? 1,
        output,
        durationMs: Date.now() - started,
        timedOut,
      });
    };

    const timer = s.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, s.timeoutMs)
      : undefined;

    // One buffer per stream: a stderr line must not split a key on stdout.
    // Each buffer redacts complete lines; flush both tails on close.
    const stdoutLines = createLineRedactor(REDACTOR.redact);
    const stderrLines = createLineRedactor(REDACTOR.redact);
    const write = (text) => {
      output += text;
      process.stdout.write(text);
    };
    const flush = () => {
      for (const buffer of [stdoutLines, stderrLines]) {
        const text = buffer.flush();
        if (text) write(text);
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = stdoutLines.push(chunk);
      if (text) write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = stderrLines.push(chunk);
      if (text) write(text);
    });
    child.on("error", (error) => {
      flush();
      const text = `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
      output += REDACTOR.redact(text);
      process.stderr.write(output);
      finish(1);
    });
    child.on("close", (code) => {
      flush();
      finish(code ?? 1);
    });
  });
}

function countFor(text, word) {
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index + 1] === word && /^\d+$/.test(tokens[index])) return Number(tokens[index]);
  }
  return undefined;
}

function parseVitest(output) {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Tests")) continue;
    const open = trimmed.indexOf("(");
    const close = trimmed.lastIndexOf(")");
    if (open <= 0 || close <= open) continue;
    const total = Number(trimmed.slice(open + 1, close));
    if (!Number.isFinite(total)) continue;
    const parts = trimmed.slice(0, open);
    return {
      passed: countFor(parts, "passed") ?? 0,
      failed: countFor(parts, "failed") ?? 0,
      skipped: countFor(parts, "skipped") ?? 0,
      total,
      kind: "vitest",
    };
  }
  return null;
}

function parseMocha(output) {
  // WDIO prints one summary per spec file. Sum every summary so the lane
  // reports the whole suite, not just the first spec.
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let sawSummary = false;
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || !/^\d+$/.test(parts[0])) continue;
    const count = Number(parts[0]);
    if (parts[1] === "passing") {
      passed += count;
      sawSummary = true;
    } else if (parts[1] === "failing") {
      failed += count;
      sawSummary = true;
    } else if (parts[1] === "pending" || parts[1] === "skipped") {
      skipped += count;
      sawSummary = true;
    }
  }
  return sawSummary ? { passed, failed, skipped, total: passed + failed + skipped, kind: "mocha" } : null;
}

function parseWdioSpecs(output) {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Spec Files:")) continue;
    const tokens = trimmed.split(/\s+/);
    const passed = countBeforeToken(tokens, "passed");
    const total = countBeforeToken(tokens, "total");
    if (passed === undefined || total === undefined) continue;
    return {
      passed,
      failed: total - passed,
      skipped: 0,
      total,
      kind: "wdio-specs",
    };
  }
  return null;
}

function countBeforeToken(tokens, suffix) {
  const index = tokens.findIndex((token) => token.startsWith(suffix));
  if (index <= 0) return undefined;
  const value = Number(tokens[index - 1].replace(",", ""));
  return Number.isFinite(value) ? value : undefined;
}

export function parseCounts(output) {
  return parseVitest(output) ?? parseMocha(output) ?? parseWdioSpecs(output);
}

function stepStatus(result) {
  if (result.timedOut) return "TIMEOUT";
  if (result.code !== 0) return "FAIL";
  const counts = parseCounts(result.output);
  if (result.expectTests && counts) {
    if (counts.total === 0) return "FAIL";
    if (counts.passed === 0 && counts.skipped > 0) return "FAIL";
  }
  return "PASS";
}

function detailFor(result, status) {
  const counts = parseCounts(result.output);
  if (status === "TIMEOUT") return `no exit within ${Math.round((result.timeoutMs ?? 0) / 1000)}s`;
  if (counts) {
    const skipped = counts.skipped > 0 ? `, ${counts.skipped} skipped` : "";
    return `${counts.passed} passed, ${counts.failed} failed${skipped} (${counts.kind})`;
  }
  if (result.expectTests && status === "PASS") return "exit 0, no test count found";
  return `exit ${result.code}`;
}

function explainStatus(result, status) {
  const counts = parseCounts(result.output);
  if (status !== "FAIL" || !result.expectTests || !counts) return;
  if (counts.total === 0) {
    process.stderr.write(
      `\n[verify] ${result.label} exited 0 but ran no tests. Treat that as a failure, not a pass.\n`,
    );
  } else if (counts.passed === 0 && counts.skipped > 0) {
    process.stderr.write(
      `\n[verify] ${result.label} exited 0 because every test skipped (${counts.skipped}). ` +
        "Set the credentials or environment it needs, or run a lane that can actually execute.\n",
    );
  }
}

export function isTsxIpcSandboxFailure(output) {
  return /listen EPERM: operation not permitted .*tsx-\d+\/.+\.pipe/s.test(output);
}

export function isChromedriverSandboxFailure(output) {
  return /CreatePlatformSocket\(\) failed: Operation not permitted|Could not start chromedriver/s.test(output);
}

function isKnownNestedE2eSandboxFailure(output) {
  return output.trim() === "" || isTsxIpcSandboxFailure(output) || isChromedriverSandboxFailure(output);
}

function printNestedE2eSandboxHint(output) {
  if (!isKnownNestedE2eSandboxFailure(output)) return;
  process.stderr.write(`
[verify] The core checks passed, but the smoke e2e runner did not start.
[verify] In sandboxed shells this can happen when nested e2e needs local IPC/listen sockets.
[verify] Rerun the smoke e2e as a top-level command:
[verify]   npm run verify -- app smoke
[verify] Without a display, run \`npm run verify -- check --no-app\` and let CI run the app job.
`);
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "step";
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function printTable(results, lane) {
  const labelWidth = Math.max(5, ...results.map((result) => result.label.length));
  const statusWidth = 7;
  process.stdout.write(`\n[verify] lane: ${lane}\n`);
  for (const result of results) {
    const status = stepStatus(result);
    const detail = detailFor(result, status);
    process.stdout.write(
      `  ${pad(status, statusWidth)} ${pad(result.label, labelWidth)}  ${pad(formatDuration(result.durationMs), 8)}  ${detail}\n`,
    );
  }
}

function runDir(startedAt) {
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  return path.resolve("logs", "verify", stamp);
}

/**
 * Unit steps also write Vitest's JSON report into the run dir, so the run
 * result can name each test and its time. The console output is unchanged.
 */
function withJsonReporter(s, dir, index) {
  if (!s.vitestJson) return s;
  const reportPath = path.join(dir, `vitest-${String(index + 1).padStart(2, "0")}.json`);
  const reporters = s.args.includes("--reporter=default") ? [] : ["--reporter=default"];
  return {
    ...s,
    args: [...s.args, ...reporters, "--reporter=json", `--outputFile.json=${reportPath}`],
    reportPath,
  };
}

function testsFrom(results) {
  const tests = [];
  for (const result of results) {
    if (!result.reportPath || !existsSync(result.reportPath)) continue;
    try {
      tests.push(...parseVitestJson(JSON.parse(readFileSync(result.reportPath, "utf8")), process.cwd()));
    } catch {
      // A torn report (killed run) leaves step counts only.
    }
  }
  return tests;
}

/** "all" unless a unit step named files (`change <file...>`). */
function scopeOf(results) {
  const files = results
    .filter((result) => result.vitestJson)
    .flatMap((result) => result.args.filter((arg) => arg.endsWith(".test.ts")));
  return files.length > 0 ? files : "all";
}

async function writeSummary(results, lane, startedAt, finishedAt, verdict, laneArgs = []) {
  const dir = runDir(startedAt);
  await mkdir(dir, { recursive: true });

  const steps = await Promise.all(
    results.map(async (result, index) => {
      const status = stepStatus(result);
      const counts = parseCounts(result.output);
      const logName = `${String(index + 1).padStart(2, "0")}-${slug(result.label)}.log`;
      await writeFile(path.join(dir, logName), result.output);
      return {
        label: result.label,
        status,
        code: result.code,
        durationMs: result.durationMs,
        counts,
        log: logName,
        command: REDACTOR.redact([result.command, ...result.args].join(" ")),
      };
    }),
  );

  const summary = {
    lane,
    verdict,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    steps,
  };
  await writeFile(path.join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  const rows = steps
    .map(
      (entry) =>
        `| ${entry.status} | ${entry.label} | ${formatDuration(entry.durationMs)} | ${
          entry.counts
            ? `${entry.counts.passed} passed, ${entry.counts.failed} failed, ${entry.counts.skipped} skipped`
            : `exit ${entry.code}`
        } |`,
    )
    .join("\n");
  await writeFile(
    path.join(dir, "summary.md"),
    `# Verify: ${lane}\n\n- verdict: **${verdict}**\n- duration: ${formatDuration(summary.durationMs)}\n\n| Status | Step | Duration | Detail |\n|---|---|---|---|\n${rows}\n`,
  );

  const envelope = buildRunResult({
    lane,
    args: laneArgs,
    command: `npm run verify -- ${[lane, ...laneArgs].join(" ")}`,
    verdict,
    startedAt,
    finishedAt,
    steps: steps.map((entry, index) => ({
      ...entry,
      tier: results[index].tier,
      mode: results[index].mode,
    })),
    tests: testsFrom(results),
    scope: scopeOf(results),
    artifacts: [path.relative(process.cwd(), path.join(dir, "summary.json"))],
    git: gitInfo(),
  });
  await writeFile(path.join(dir, "run-result.json"), `${JSON.stringify(envelope, null, 2)}\n`);
  const tierLine = Object.entries(envelope.tiers)
    .filter(([, counts]) => counts.total > 0)
    .map(([tier, counts]) => `${tier} ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`)
    .join("; ");
  process.stdout.write(`[verify] mode: ${envelope.mode}; counts: ${tierLine || "no test counts"}\n`);
  // History is advisory: a failure to append never changes the verdict.
  if (results.some((result) => result.record !== false) && process.env.AGENTIC_CHAT_HISTORY !== "0") {
    try {
      appendHistory(envelope);
    } catch (error) {
      process.stderr.write(`[verify] history not written: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  return dir;
}

async function main() {
  const laneName = process.argv[2] ?? "check";
  const laneArgs = process.argv.slice(3);

  if (laneName === "--help" || laneName === "-h" || laneName === "help") {
    process.stdout.write(usage());
    return 0;
  }
  if (laneName === "--list") {
    process.stdout.write(`${LANE_NAMES.join("\n")}\n`);
    return 0;
  }

  if (Object.hasOwn(RETIRED_LANES, laneName)) {
    process.stderr.write(
      `verify: the "${laneName}" lane was removed (#393). Use: npm run verify -- ${RETIRED_LANES[laneName]}\n`,
    );
    return 2;
  }
  const buildLane = Object.hasOwn(lanes, laneName) ? lanes[laneName] : undefined;
  if (!buildLane) {
    process.stderr.write(`Unknown verify lane: ${laneName}\n\n${usage()}`);
    return 1;
  }

  let steps;
  try {
    steps = buildLane(laneArgs);
  } catch (error) {
    process.stderr.write(`verify ${laneName}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const startedAt = Date.now();
  const results = [];

  process.stdout.write(`[verify] ${laneName}: ${steps.length} steps\n`);

  const dir = runDir(startedAt);
  await mkdir(dir, { recursive: true });
  for (const [index, rawStep] of steps.entries()) {
    const s = withJsonReporter(rawStep, dir, index);
    process.stdout.write(`\n[verify] ${s.label}\n`);
    const result = await runStep(s);
    results.push(result);
    const status = stepStatus(result);
    explainStatus(result, status);
    if (status === "PASS") continue;

    if (s.explainE2eSandboxFailure) printNestedE2eSandboxHint(result.output);
    printTable(results, laneName);
    await writeSummary(results, laneName, startedAt, Date.now(), "FAIL", laneArgs);
    const exitCode = result.code === 0 ? 1 : result.code;
    process.stderr.write(`\n[verify] ${s.label} failed with exit code ${exitCode}.\n`);
    process.stderr.write(`[verify] artifacts: ${dir}\n`);
    return exitCode;
  }

  printTable(results, laneName);
  await writeSummary(results, laneName, startedAt, Date.now(), "PASS", laneArgs);
  process.stdout.write(`\n[verify] all checks passed\n[verify] artifacts: ${dir}\n`);
  return 0;
}

const exitCode = await main();
process.exitCode = exitCode;
