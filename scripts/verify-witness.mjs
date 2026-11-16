#!/usr/bin/env node
/* eslint-disable no-console -- CLI verifier prints its verdict and evidence to stdout. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { appendHistory, buildRunResult, gitInfo } from "./lib/run-result.mjs";

/**
 * Prove that a test is a witness: it must fail when the production change is
 * reverted and pass when the change is restored.
 *
 * The script never trusts a test that only passes on the current tree. It
 * applies the source diff in reverse, runs the test, restores the diff, and runs
 * the test again. A real witness is red then green.
 *
 * Usage:
 *   npm run verify:witness -- \
 *     --base origin/main \
 *     --test-file test/agent-conversation.test.ts \
 *     --src src/agent/conversation.ts
 *
 * Or with an arbitrary command:
 *   npm run verify:witness -- \
 *     --base origin/main \
 *     --test "npm run verify -- change test/agent-conversation.test.ts" \
 *     --src src/agent/conversation.ts
 *
 * Self-test:
 *   npm run verify:witness -- --self-test
 */

const TEST_TIMEOUT_MS = 15 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 8_000;

/**
 * Output that proves the red run never reached an assertion. A loader, parser,
 * or compiler failure exits non-zero, but it says nothing about the behavior
 * under test. Treating it as a witness makes the verdict lie.
 */
const NON_ASSERTION_RED_MARKERS = [
  { label: "SyntaxError", pattern: /SyntaxError/ },
  { label: "MODULE_NOT_FOUND", pattern: /MODULE_NOT_FOUND/ },
  { label: "ERR_MODULE_NOT_FOUND", pattern: /ERR_MODULE_NOT_FOUND/ },
  { label: "Cannot find module", pattern: /Cannot find module/ },
  { label: "Does not provide an export named", pattern: /Does not provide an export named/ },
  { label: "Failed to load url", pattern: /Failed to load url/ },
  { label: "Transform failed", pattern: /Transform failed/ },
  { label: "Unexpected token", pattern: /Unexpected token/ },
  { label: "TSError", pattern: /TSError/ },
  { label: "TypeScript compiler error", pattern: /error TS\d+/ },
  // A bundled or transformed import that resolved to nothing. The test asked
  // for an export the reverted tree does not have: a loader red, not a behavior red.
  { label: "missing import binding", pattern: /\(0\s*,\s*[\w$]+\.[\w$]+\) is not a function/ },
  { label: "missing import binding", pattern: /__vi_import_\d+__\.[\w$]+ is not a (?:function|constructor)/ },
  {
    label: "setup hook failure",
    pattern: /\b(?:beforeEach|beforeAll|afterEach|afterAll)\b[^\n]*\b(?:failed|error)\b/i,
  },
];

/**
 * A crash marker that is a real red only when the test is the one the base
 * already had. When the PR changed or added the test, a TypeError usually
 * means the test calls something the reverted tree lacks. When the test is
 * unchanged, the same TypeError comes from the product code the fix repairs.
 */
const CHANGED_TEST_RED_MARKERS = [
  { label: "TypeError", pattern: /\bTypeError\b/ },
  { label: "is not a function", pattern: /\bis not a function\b/ },
];

const FAILED_TEST_COUNT_PATTERNS = [
  // Vitest: "Tests  1 failed | 4 passed (5)"
  /\bTests\s+(\d+)\s+failed\b/,
  // Mocha: "1 failing"; WDIO: "Spec Files: ... 1 failed ..."; generic: "3 failed"
  /\b(\d+)\s+failed\b/,
  /\b(\d+)\s+failing\b/,
];

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

/** CI reporters color the count, so the digits may follow an escape code. */
function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
}

function usage() {
  return `verify-witness — prove a test fails without the fix

Options:
  --base <ref>        Required. Base ref to diff against (for example origin/main).
  --test-file <path>  Test file to run through "npm run verify -- change <path>".
  --test <command>    Arbitrary shell command to run as the witness.
  --src <path>        Source path to revert. Repeat for several paths.
  --report-dir <dir>  Where to write summary.json and report.md.
  --dry-run           Check the patch and print the plan; do not run tests.
  --self-test         Prove the verifier itself in a temporary git repository.
  --help              Show this help.

One of --test-file or --test is required unless --self-test is set.
At least one --src is required unless --self-test is set.
`;
}

function parseArgs(argv) {
  const options = {
    base: null,
    test: null,
    testFile: null,
    sources: [],
    reportDir: null,
    dryRun: false,
    selfTest: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--base":
        options.base = take();
        break;
      case "--test":
        options.test = take();
        break;
      case "--test-file":
        options.testFile = take();
        break;
      case "--src":
        options.sources.push(take());
        break;
      case "--report-dir":
        options.reportDir = take();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--self-test":
        options.selfTest = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function resolveTest(options) {
  if (options.testCommand) return options.testCommand;
  if (options.test) {
    return {
      display: options.test,
      command: options.test,
      args: [],
      shell: true,
    };
  }
  if (options.testFile) {
    return {
      display: `npm run verify -- change ${options.testFile}`,
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", "verify", "--", "change", options.testFile],
      shell: false,
    };
  }
  throw new Error("Provide --test-file or --test.");
}

function run(command, args, cwd, shell = false) {
  const result = spawnSync(command, args, {
    cwd,
    shell,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : undefined,
  };
}

function runTest(spec, cwd) {
  const result = run(spec.command, spec.args, cwd, spec.shell);
  return {
    ...result,
    combined: [result.stdout, result.stderr].filter(Boolean).join("\n"),
  };
}

function git(args, cwd, options = {}) {
  const result = run("git", args, cwd, false);
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function tail(text, maxChars = OUTPUT_TAIL_CHARS) {
  if (text.length <= maxChars) return text;
  return `… ${text.length - maxChars} chars omitted …\n${text.slice(-maxChars)}`;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function nonAssertionRedMarker(output, { testChanged = true } = {}) {
  const markers = testChanged
    ? [...NON_ASSERTION_RED_MARKERS, ...CHANGED_TEST_RED_MARKERS]
    : NON_ASSERTION_RED_MARKERS;
  const match = markers.find((marker) => marker.pattern.test(output));
  return match?.label;
}

function failedTestCount(output) {
  for (const pattern of FAILED_TEST_COUNT_PATTERNS) {
    const match = pattern.exec(output);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function verdictFor(reverted, restored, { testChanged = true } = {}) {
  if (reverted.status === 0) {
    return {
      verdict: "FAIL",
      reason: "the test passed with the fix reverted, so it does not prove the fix",
    };
  }
  if ((restored.status ?? 1) !== 0) {
    return {
      verdict: "FAIL",
      reason: "the test failed with the fix restored, so the head is not green",
    };
  }
  const red = stripAnsi(reverted.combined);
  const marker = nonAssertionRedMarker(red, { testChanged });
  if (marker) {
    return {
      verdict: "FAIL",
      reason: "red run did not reach an assertion.",
      detail: `Matched non-assertion marker: ${marker}`,
      failedTests: failedTestCount(red),
    };
  }
  const failedTests = failedTestCount(red);
  if (failedTests === undefined) {
    return {
      verdict: "FAIL",
      reason: "red run did not report a failed test count, so it does not prove an assertion ran.",
    };
  }
  if (failedTests < 1) {
    return {
      verdict: "FAIL",
      reason: "red run reported zero failed tests, so it does not prove an assertion ran.",
      failedTests,
    };
  }
  return {
    verdict: "PASS",
    reason: `test failed without the fix (${failedTests} failed) and passed with it`,
    failedTests,
  };
}

function renderReport(result) {
  const exitText = (run) => {
    const code = run.status === null ? "null" : String(run.status);
    return run.signal ? `${code} (signal ${run.signal})` : code;
  };
  return [
    "# Witness verification",
    "",
    `- Verdict: **${result.verdict}**`,
    `- Reason: ${result.reason}`,
    ...(result.detail ? [`- Detail: ${result.detail}`] : []),
    ...(result.failedTests !== undefined ? [`- Failed tests in red run: ${result.failedTests}`] : []),
    `- Base: \`${result.base}\``,
    `- Head: \`${result.head}\``,
    `- Sources: ${result.sources.map((source) => `\`${source}\``).join(", ")}`,
    `- Test: \`${result.testDisplay}\``,
    `- Patch: \`${result.patchPath}\``,
    "",
    "## Fix reverted (expected fail)",
    "",
    `Exit: ${exitText(result.reverted)}`,
    "",
    "```text",
    tail(result.reverted.combined),
    "```",
    "",
    "## Fix restored (expected pass)",
    "",
    `Exit: ${exitText(result.restored)}`,
    "",
    "```text",
    tail(result.restored.combined),
    "```",
    "",
  ].join("\n");
}

function writeReport(reportDir, result) {
  mkdirSync(reportDir, { recursive: true });
  const summaryPath = path.join(reportDir, "summary.json");
  const reportPath = path.join(reportDir, "report.md");
  writeFileSync(
    summaryPath,
    `${JSON.stringify(
      {
        verdict: result.verdict,
        reason: result.reason,
        detail: result.detail,
        failedTests: result.failedTests,
        base: result.base,
        head: result.head,
        sources: result.sources,
        test: result.testDisplay,
        patchPath: result.patchPath,
        reverted: {
          status: result.reverted.status,
          signal: result.reverted.signal,
          error: result.reverted.error,
          outputTail: tail(result.reverted.combined),
        },
        restored: {
          status: result.restored.status,
          signal: result.restored.signal,
          error: result.restored.error,
          outputTail: tail(result.restored.combined),
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(reportPath, renderReport(result));
  return { summaryPath, reportPath };
}

/**
 * True unless the named test file is byte-identical at the base and the head.
 * An arbitrary `--test` command names no file, so it counts as changed.
 */
function testFileChanged(options, cwd) {
  if (!options.testFile) return true;
  const atBase = git(["cat-file", "-e", `${options.base}:${options.testFile}`], cwd, { allowFailure: true });
  if (atBase.status !== 0) return true;
  const diff = git(["diff", "--quiet", `${options.base}...HEAD`, "--", options.testFile], cwd, {
    allowFailure: true,
  });
  return diff.status !== 0;
}

function verifyWitness(options, cwd = process.cwd()) {
  const startedAt = Date.now();
  const spec = resolveTest(options);
  if (!options.base) throw new Error("Provide --base.");
  if (options.sources.length === 0) throw new Error("Provide at least one --src.");

  const dirty = git(["status", "--porcelain", "--", ...options.sources], cwd);
  if (dirty.stdout.trim()) {
    throw new Error(
      `Source paths are dirty. Commit or stash them before running the witness:\n${dirty.stdout.trim()}`,
    );
  }

  const head = git(["rev-parse", "HEAD"], cwd).stdout.trim();
  const patch = git(["diff", "--binary", `${options.base}...HEAD`, "--", ...options.sources], cwd).stdout;
  if (!patch.trim()) {
    throw new Error(`No source diff between ${options.base} and HEAD for ${options.sources.join(", ")}.`);
  }

  const reportDir = options.reportDir ?? path.join(cwd, "logs", "witness", timestamp());
  mkdirSync(reportDir, { recursive: true });
  const patchPath = path.join(reportDir, "witness.patch");
  writeFileSync(patchPath, patch);

  const reverseCheck = git(["apply", "--reverse", "--check", patchPath], cwd, { allowFailure: true });
  if (reverseCheck.status !== 0) {
    throw new Error(
      `The diff does not apply in reverse. The working tree may not match HEAD.\n${reverseCheck.stderr || reverseCheck.stdout}`,
    );
  }

  if (options.dryRun) {
    return {
      verdict: "DRY-RUN",
      reason: "patch applies in reverse; tests were not run",
      base: options.base,
      head,
      sources: options.sources,
      testDisplay: spec.display,
      patchPath,
      reportDir,
      reverted: { status: null, signal: null, combined: "" },
      restored: { status: null, signal: null, combined: "" },
    };
  }

  let applied = false;
  let reverted;
  let restoreFailure;
  try {
    git(["apply", "--reverse", patchPath], cwd);
    applied = true;
    reverted = runTest(spec, cwd);
  } finally {
    if (applied) {
      const restore = git(["apply", patchPath], cwd, { allowFailure: true });
      if (restore.status !== 0) {
        restoreFailure = new Error(
          `Could not restore the fix after the reverted run. Restore it by hand before continuing.\n${restore.stderr || restore.stdout}`,
        );
      }
    }
  }
  if (restoreFailure) throw restoreFailure;

  const restored = runTest(spec, cwd);
  const decision = verdictFor(reverted, restored, { testChanged: testFileChanged(options, cwd) });
  return {
    ...decision,
    startedAt,
    base: options.base,
    head,
    sources: options.sources,
    testDisplay: spec.display,
    patchPath,
    reportDir,
    reverted,
    restored,
  };
}

/** The shared run-result envelope (#393 T24). Advisory: never changes the verdict. */
function recordRun(result) {
  try {
    const finishedAt = Date.now();
    const envelope = buildRunResult({
      lane: "witness",
      args: ["--base", result.base, ...result.sources.flatMap((source) => ["--src", source])],
      command: result.testDisplay,
      verdict: result.verdict,
      startedAt: result.startedAt ?? finishedAt,
      finishedAt,
      steps: [
        { label: "fix reverted (expect red)", tier: "T1", status: result.reverted.status === 0 ? "FAIL" : "PASS", durationMs: 0 },
        { label: "fix restored (expect green)", tier: "T1", status: result.restored.status === 0 ? "PASS" : "FAIL", durationMs: 0 },
      ],
      scope: [],
      artifacts: [path.join(result.reportDir, "summary.json")],
      git: gitInfo(),
    });
    writeFileSync(path.join(result.reportDir, "run-result.json"), `${JSON.stringify(envelope, null, 2)}\n`);
    if (process.env.AGENTIC_CHAT_HISTORY !== "0") appendHistory(envelope);
  } catch (error) {
    console.error(`verify-witness: run result not recorded (${error.message})`);
  }
}

function printResult(result) {
  console.log(`verify-witness: ${result.verdict}`);
  console.log(`  reason: ${result.reason}`);
  if (result.detail) console.log(`  detail: ${result.detail}`);
  if (result.failedTests !== undefined) console.log(`  failed tests: ${result.failedTests}`);
  console.log(`  base: ${result.base}`);
  console.log(`  head: ${result.head}`);
  console.log(`  test: ${result.testDisplay}`);
  console.log(`  reverted: exit ${result.reverted.status ?? "null"} (expected non-zero)`);
  console.log(`  restored: exit ${result.restored.status ?? "null"} (expected zero)`);
  if (result.reportDir) console.log(`  report: ${result.reportDir}`);
}

function selfTest() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "agentic-chat-witness-"));
  try {
    const repo = path.join(scratch, "repo");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    mkdirSync(path.join(repo, "test"), { recursive: true });

    const gitInit = (args) => {
      const result = run("git", args, repo, false);
      if (result.status !== 0) throw new Error(`self-test git ${args.join(" ")} failed: ${result.stderr}`);
      return result;
    };
    gitInit(["init"]);
    gitInit(["config", "user.email", "witness@example.test"]);
    gitInit(["config", "user.name", "Witness Self Test"]);

    const sourcePath = path.join(repo, "src", "math.mjs");
    const testPath = path.join(repo, "test", "math.test.mjs");
    const alwaysPath = path.join(repo, "test", "always.test.mjs");

    const commit = (message) => {
      gitInit(["add", "."]);
      gitInit(["commit", "-m", message]);
      return gitInit(["rev-parse", "HEAD"]).stdout.trim();
    };

    // A tiny test harness that prints a runner-shaped count, like Vitest or
    // Mocha do. The verifier needs that count to prove an assertion ran.
    const countedTest = (body) =>
      [
        'import assert from "node:assert/strict";',
        ...body,
        "try {",
        "  check();",
        '  console.log("\\u001b[2mTests\\u001b[22m \\u001b[31m1 passed\\u001b[39m (1)");',
        "} catch (error) {",
        '  console.log("\\u001b[2mTests\\u001b[22m \\u001b[31m1 failed\\u001b[39m (1)");',
        "  console.error(error instanceof Error ? error.message : String(error));",
        "  process.exitCode = 1;",
        "}",
        "",
      ].join("\n");

    writeFileSync(sourcePath, "export const add = (a, b) => a - b;\n");
    writeFileSync(
      testPath,
      countedTest([
        'import { add } from "../src/math.mjs";',
        "function check() {",
        "  assert.equal(add(2, 3), 5);",
        "}",
      ]),
    );
    const buggyBase = commit("base with bug");

    writeFileSync(sourcePath, "export const add = (a, b) => a + b;\n");
    commit("fix");

    const positive = verifyWitness(
      {
        base: buggyBase,
        sources: ["src/math.mjs"],
        testCommand: {
          display: `${process.execPath} test/math.test.mjs`,
          command: process.execPath,
          args: [testPath],
          shell: false,
        },
        reportDir: path.join(scratch, "positive-report"),
      },
      repo,
    );
    if (positive.verdict !== "PASS") {
      throw new Error(`self-test positive case failed: ${positive.reason}`);
    }

    writeFileSync(alwaysPath, 'console.log("always ok");\n');
    commit("add a test that proves nothing");

    const negative = verifyWitness(
      {
        base: buggyBase,
        sources: ["src/math.mjs"],
        testCommand: {
          display: `${process.execPath} test/always.test.mjs`,
          command: process.execPath,
          args: [alwaysPath],
          shell: false,
        },
        reportDir: path.join(scratch, "negative-report"),
      },
      repo,
    );
    if (negative.verdict !== "FAIL") {
      throw new Error("self-test negative case passed: a test that ignores the fix was accepted");
    }

    // Red run dies in the loader, not in an assertion. Before the hardening
    // this returned PASS because the process exited non-zero.
    const brokenPath = path.join(repo, "src", "broken.mjs");
    const brokenTestPath = path.join(repo, "test", "broken.test.mjs");
    writeFileSync(brokenPath, "export const value = () => ;\n");
    writeFileSync(
      brokenTestPath,
      [
        'import assert from "node:assert/strict";',
        'import { value } from "../src/broken.mjs";',
        "assert.equal(value(), 2);",
        'console.log("Tests 1 passed (1)");',
        "",
      ].join("\n"),
    );
    const brokenBase = commit("break the source syntax");

    writeFileSync(brokenPath, "export const value = () => 2;\n");
    commit("repair the source syntax");

    const syntax = verifyWitness(
      {
        base: brokenBase,
        sources: ["src/broken.mjs"],
        testCommand: {
          display: `${process.execPath} test/broken.test.mjs`,
          command: process.execPath,
          args: [brokenTestPath],
          shell: false,
        },
        reportDir: path.join(scratch, "syntax-report"),
      },
      repo,
    );
    if (syntax.verdict !== "FAIL") {
      throw new Error("self-test syntax case passed: a loader failure was accepted as a witness");
    }
    if (!syntax.reason.includes("red run did not reach an assertion")) {
      throw new Error(`self-test syntax case gave the wrong reason: ${syntax.reason}`);
    }

    // Red run dies in a setup hook before any test assertion runs.
    const setupPath = path.join(repo, "test", "setup.test.mjs");
    writeFileSync(
      setupPath,
      [
        'console.log("Tests 1 failed (1)");',
        'console.error("TypeError: writeLock is not a function");',
        "process.exitCode = 1;",
        "",
      ].join("\n"),
    );
    const setupBase = commit("add a setup hook failure");
    writeFileSync(setupPath, 'console.log("Tests 1 passed (1)");\n');
    commit("repair the setup hook");

    const setup = verifyWitness(
      {
        base: setupBase,
        sources: ["test/setup.test.mjs"],
        testCommand: {
          display: `${process.execPath} test/setup.test.mjs`,
          command: process.execPath,
          args: [setupPath],
          shell: false,
        },
        reportDir: path.join(scratch, "setup-report"),
      },
      repo,
    );
    if (setup.verdict !== "FAIL") {
      throw new Error("self-test setup case passed: a setup hook failure was accepted as a witness");
    }
    if (!setup.reason.includes("red run did not reach an assertion")) {
      throw new Error(`self-test setup case gave the wrong reason: ${setup.reason}`);
    }

    // Red run exits non-zero but never reports how many tests failed.
    const uncountedPath = path.join(repo, "test", "uncounted.test.mjs");
    writeFileSync(
      uncountedPath,
      [
        'import { add } from "../src/math.mjs";',
        "if (add(2, 3) !== 5) {",
        '  console.error("wrong result");',
        "  process.exit(1);",
        "}",
        'console.log("ok");',
        "",
      ].join("\n"),
    );
    commit("add a failing test without a count");

    const uncounted = verifyWitness(
      {
        base: buggyBase,
        sources: ["src/math.mjs"],
        testCommand: {
          display: `${process.execPath} test/uncounted.test.mjs`,
          command: process.execPath,
          args: [uncountedPath],
          shell: false,
        },
        reportDir: path.join(scratch, "uncounted-report"),
      },
      repo,
    );
    if (uncounted.verdict !== "FAIL") {
      throw new Error("self-test uncounted case passed: a red run without a test count was accepted");
    }
    if (!uncounted.reason.includes("did not report a failed test count")) {
      throw new Error(`self-test uncounted case gave the wrong reason: ${uncounted.reason}`);
    }

    // Red run is a TypeError from the product code, and the test is the one
    // the base already had. That is the crash the fix repairs: a real red.
    const lockPath = path.join(repo, "src", "lock.mjs");
    const lockTestPath = path.join(repo, "test", "lock.test.mjs");
    writeFileSync(lockPath, "export const lock = undefined;\n");
    writeFileSync(
      lockTestPath,
      countedTest([
        'import { lock } from "../src/lock.mjs";',
        "function check() {",
        "  assert.equal(lock(), true);",
        "}",
      ]),
    );
    const crashBase = commit("product crash: lock is not a function");
    writeFileSync(lockPath, "export const lock = () => true;\n");
    commit("fix the crash");

    const crash = verifyWitness(
      {
        base: crashBase,
        sources: ["src/lock.mjs"],
        testFile: "test/lock.test.mjs",
        testCommand: {
          display: `${process.execPath} test/lock.test.mjs`,
          command: process.execPath,
          args: [lockTestPath],
          shell: false,
        },
        reportDir: path.join(scratch, "crash-report"),
      },
      repo,
    );
    if (crash.verdict !== "PASS") {
      throw new Error(`self-test product TypeError case failed: ${crash.reason} ${crash.detail ?? ""}`);
    }

    // A fix that deletes a source file: the red side restores it from the base.
    const legacyPath = path.join(repo, "src", "legacy.mjs");
    const legacyTestPath = path.join(repo, "test", "legacy.test.mjs");
    writeFileSync(legacyPath, 'export const mode = "legacy";\n');
    const legacyBase = commit("add a legacy module");
    rmSync(legacyPath);
    writeFileSync(
      legacyTestPath,
      countedTest([
        'import { existsSync } from "node:fs";',
        "function check() {",
        '  assert.equal(existsSync(new URL("../src/legacy.mjs", import.meta.url)), false);',
        "}",
      ]),
    );
    commit("delete the legacy module");

    const deleted = verifyWitness(
      {
        base: legacyBase,
        sources: ["src/legacy.mjs"],
        testCommand: {
          display: `${process.execPath} test/legacy.test.mjs`,
          command: process.execPath,
          args: [legacyTestPath],
          shell: false,
        },
        reportDir: path.join(scratch, "deleted-report"),
      },
      repo,
    );
    if (deleted.verdict !== "PASS") {
      throw new Error(`self-test deleted source case failed: ${deleted.reason}`);
    }

    console.log("SELF-TEST PASS");
    console.log("  positive: red without the fix, green with it");
    console.log("  negative: rejected a test that passes without the fix");
    console.log("  syntax error: rejected a red run that never reached an assertion");
    console.log("  setup hook: rejected a red run that died before an assertion");
    console.log("  no count: rejected a red run without a failed test count");
    console.log("  product crash: accepted a TypeError red when the test is unchanged");
    console.log("  deleted source: restored a deleted file on the red side");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`verify-witness: ${error.message}`);
    console.error(usage());
    process.exit(2);
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.selfTest) {
    try {
      selfTest();
    } catch (error) {
      console.error(`verify-witness self-test: FAIL\n  ${error.message}`);
      process.exit(1);
    }
    return;
  }

  let result;
  try {
    result = verifyWitness(options);
  } catch (error) {
    console.error(`verify-witness: ERROR\n  ${error.message}`);
    process.exit(2);
  }

  if (result.verdict !== "DRY-RUN") {
    writeReport(result.reportDir, result);
    recordRun(result);
  }
  printResult(result);
  if (result.verdict === "FAIL") {
    console.error("verify-witness: red output");
    console.error(tail(result.reverted.combined));
  }
  process.exit(result.verdict === "PASS" || result.verdict === "DRY-RUN" ? 0 : 1);
}

main();
