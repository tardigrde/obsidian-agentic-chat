import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendHistory,
  buildRunResult,
  gitInfo,
  historyPath,
  parseVitestJson,
  readHistory,
  summarizeHistory,
  type TestRow,
} from "../scripts/lib/run-result.mjs";
import { formatStatus } from "../scripts/tests-status.mjs";

const T0 = Date.UTC(2026, 10, 16, 12);

function run(options: {
  lane?: string;
  verdict?: string;
  head: string;
  tests?: TestRow[];
  scope?: "all" | string[];
  stepMs?: number;
  worktree?: string;
  at?: number;
}) {
  const failed = (options.tests ?? []).filter((test) => test.status === "failed").length;
  const passed = (options.tests ?? []).filter((test) => test.status === "passed").length;
  return buildRunResult({
    lane: options.lane ?? "check",
    verdict: options.verdict ?? (failed > 0 ? "FAIL" : "PASS"),
    startedAt: options.at ?? T0,
    finishedAt: (options.at ?? T0) + 1000,
    steps: [
      {
        label: "unit tests",
        tier: "T1",
        status: failed > 0 ? "FAIL" : "PASS",
        durationMs: options.stepMs ?? 1000,
        counts: { passed, failed, skipped: 0, total: passed + failed },
      },
    ],
    tests: options.tests ?? [],
    scope: options.scope ?? "all",
    git: { head: options.head, branch: "b", dirty: false, worktree: options.worktree ?? "/wt/main" },
  });
}

const test = (id: string, status: TestRow["status"], durationMs = 10): TestRow => ({
  id: `test/a.test.ts > ${id}`,
  file: "test/a.test.ts",
  status,
  durationMs,
});

describe("run result envelope", () => {
  it("reports counts per tier and the mode", () => {
    const envelope = buildRunResult({
      lane: "check",
      verdict: "PASS",
      startedAt: T0,
      finishedAt: T0 + 5000,
      steps: [
        { label: "lint", tier: "T0", status: "PASS", durationMs: 10, counts: null },
        { label: "unit tests", tier: "T1", status: "PASS", durationMs: 10, counts: { passed: 3, failed: 0, skipped: 0, total: 3 } },
        { label: "smoke e2e", tier: "T2", status: "PASS", durationMs: 10, counts: { passed: 9, failed: 0, skipped: 0, total: 9 } },
      ],
    });
    expect(envelope.mode).toBe("scripted");
    expect(envelope.tiers.T1.passed).toBe(3);
    expect(envelope.tiers.T2.passed).toBe(9);
    expect(envelope.counts.total).toBe(12);
    const live = buildRunResult({
      lane: "live",
      verdict: "PASS",
      startedAt: T0,
      finishedAt: T0,
      steps: [{ label: "live e2e", tier: "T3", mode: "live", status: "PASS", durationMs: 1 }],
    });
    expect(live.mode).toBe("live");
  });

  it("reads Vitest JSON into repo-relative test ids", () => {
    const rows = parseVitestJson(
      {
        testResults: [
          {
            name: "/repo/test/a.test.ts",
            assertionResults: [
              { fullName: "suite works", status: "passed", duration: 12.4 },
              { fullName: "suite breaks", status: "failed", duration: 3 },
              { fullName: "suite later", status: "pending" },
            ],
          },
        ],
      },
      "/repo",
    );
    expect(rows).toEqual([
      { id: "test/a.test.ts > suite works", file: "test/a.test.ts", status: "passed", durationMs: 12 },
      { id: "test/a.test.ts > suite breaks", file: "test/a.test.ts", status: "failed", durationMs: 3 },
      { id: "test/a.test.ts > suite later", file: "test/a.test.ts", status: "skipped", durationMs: 0 },
    ]);
  });
});

describe("history and tests:status", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "history-"));
    file = path.join(dir, "logs", "history.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists a test that failed once and passed on the same head as flaky", () => {
    appendHistory(run({ head: "aaa", tests: [test("x", "failed"), test("y", "passed")] }), file);
    appendHistory(run({ head: "aaa", tests: [test("x", "passed"), test("y", "passed")], worktree: "/wt/other" }), file);
    appendHistory(run({ head: "bbb", tests: [test("y", "failed")] }), file);
    const summary = summarizeHistory(readHistory(file));
    expect(summary.flaky.map((row) => row.id)).toEqual(["test/a.test.ts > x"]);
    expect(summary.lanes[0].lastRed?.head).toBe("bbb");
    const text = formatStatus(summary, file);
    expect(text).toContain("3 run(s)");
    expect(text).toContain("test/a.test.ts > x");
  });

  it("a pass that did not cover the file does not make a failure flaky", () => {
    appendHistory(run({ head: "aaa", tests: [test("x", "failed")] }), file);
    appendHistory(run({ lane: "check", head: "aaa", scope: ["test/other.test.ts"] }), file);
    expect(summarizeHistory(readHistory(file)).flaky).toEqual([]);
  });

  it("flags a step whose recent median got slower", () => {
    for (let index = 0; index < 10; index += 1) {
      appendHistory(run({ head: `h${index}`, stepMs: index < 5 ? 10_000 : 20_000, at: T0 + index }), file);
    }
    expect(summarizeHistory(readHistory(file)).slowerSteps).toEqual([
      { lane: "check", label: "unit tests", beforeMs: 10_000, recentMs: 20_000 },
    ]);
  });

  it("skips a torn line instead of failing", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"lane":"check"\n');
    expect(readHistory(file)).toEqual([]);
  });

  it("runs from two worktrees land in the main worktree's history", () => {
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "T");
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-q", "-m", "a");
    git("worktree", "add", "-q", path.join(dir, "wt2"), "-b", "wt2");
    expect(historyPath(path.join(dir, "wt2"))).toBe(path.join(repo, "logs", "history.jsonl"));
    expect(gitInfo(path.join(dir, "wt2")).branch).toBe("wt2");
  });

  it("the CLI prints a status for an empty history", () => {
    const result = spawnSync(process.execPath, ["scripts/tests-status.mjs", "--file", path.join(dir, "none.jsonl")], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No history yet");
  });
});
