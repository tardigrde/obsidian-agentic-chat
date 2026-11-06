#!/usr/bin/env node
/* eslint-disable no-console -- CLI verifier prints its verdict and evidence to stdout. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

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
 *     --test-file test/session-activation.test.ts \
 *     --src src/agent/session-activation.ts
 *
 * Or with an arbitrary command:
 *   npm run verify:witness -- \
 *     --base origin/main \
 *     --test "npm run verify -- change test/session-activation.test.ts" \
 *     --src src/agent/session-activation.ts
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
];

const FAILED_TEST_COUNT_PATTERNS = [
  // Vitest: "Tests  1 failed | 4 passed (5)"
  /\bTests\s+(\d+)\s+failed\b/,
  // Mocha: "1 failing"; WDIO: "Spec Files: ... 1 failed ..."; generic: "3 failed"
  /\b(\d+)\s+failed\b/,
  /\b(\d+)\s+failing\b/,
];

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

function nonAssertionRedMarker(output) {
  const match = NON_ASSERTION_RED_MARKERS.find((marker) => marker.pattern.test(output));
  return match?.label;
}

function failedTestCount(output) {
  for (const pattern of FAILED_TEST_COUNT_PATTERNS) {
    const match = pattern.exec(output);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function verdictFor(reverted, restored) {
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
  const marker = nonAssertionRedMarker(reverted.combined);
  if (marker) {
    return {
      verdict: "FAIL",
      reason: "red run did not reach an assertion.",
      detail: `Matched non-assertion marker: ${marker}`,
      failedTests: failedTestCount(reverted.combined),
    };
  }
  const failedTests = failedTestCount(reverted.combined);
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

function verifyWitness(options, cwd = process.cwd()) {
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
  const decision = verdictFor(reverted, restored);
  return {
    ...decision,
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
        '  console.log("Tests 1 passed (1)");',
        "} catch (error) {",
        '  console.log("Tests 1 failed (1)");',
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

    console.log("SELF-TEST PASS");
    console.log("  positive: red without the fix, green with it");
    console.log("  negative: rejected a test that passes without the fix");
    console.log("  syntax error: rejected a red run that never reached an assertion");
    console.log("  no count: rejected a red run without a failed test count");
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

  if (result.verdict !== "DRY-RUN") writeReport(result.reportDir, result);
  printResult(result);
  if (result.verdict === "FAIL") {
    console.error("verify-witness: red output");
    console.error(tail(result.reverted.combined));
  }
  process.exit(result.verdict === "PASS" || result.verdict === "DRY-RUN" ? 0 : 1);
}

main();
