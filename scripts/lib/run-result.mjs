import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * One result format for every run (#393 T24), and a local history of them.
 *
 * The envelope is written next to each run's artifacts (`run-result.json`) and
 * a compact line is appended to `logs/history.jsonl` in the MAIN worktree, so
 * runs from every worktree land in one place. `npm run tests:status` reads it.
 * Advisory: nothing fails on the history.
 */

export const RUN_RESULT_SCHEMA = "agentic-chat.run-result/1";
export const HISTORY_FILE = path.join("logs", "history.jsonl");
const SLOW_TESTS_KEPT = 25;
const FAILED_TESTS_KEPT = 200;

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" }); // NOSONAR:S4036 -- git from PATH.
  return result.status === 0 ? result.stdout.trim() : "";
}

/** The first worktree `git worktree list` prints is the main one. */
export function mainWorktreeRoot(cwd = process.cwd()) {
  const porcelain = git(["worktree", "list", "--porcelain"], cwd);
  const first = porcelain.split("\n").find((line) => line.startsWith("worktree "));
  return first ? first.slice("worktree ".length) : cwd;
}

export function gitInfo(cwd = process.cwd()) {
  return {
    head: git(["rev-parse", "HEAD"], cwd) || null,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) || null,
    dirty: git(["status", "--porcelain"], cwd) !== "",
    worktree: git(["rev-parse", "--show-toplevel"], cwd) || cwd,
  };
}

/**
 * Vitest's JSON reporter (jest-compatible) to per-test rows. Ids are
 * `<repo-relative file> > <full name>` so they are stable across worktrees.
 */
export function parseVitestJson(json, root) {
  const tests = [];
  for (const file of json?.testResults ?? []) {
    const relative = path.relative(root, file.name ?? "").replaceAll("\\", "/");
    for (const assertion of file.assertionResults ?? []) {
      const status = assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : "skipped";
      tests.push({
        id: `${relative} > ${assertion.fullName ?? assertion.title}`,
        file: relative,
        status,
        durationMs: Math.round(assertion.duration ?? 0),
      });
    }
  }
  return tests;
}

/**
 * Per manifest group counts for unit test rows: which group a test belongs to
 * comes from test/manifest.json (`groupOf(file)` returns its id). Rows with no
 * group land under "unlisted" so a gap is visible, not dropped.
 */
export function groupCounts(tests, groupOf) {
  const groups = {};
  for (const test of tests) {
    const id = groupOf(test.file) ?? "unlisted";
    groups[id] ??= { passed: 0, failed: 0, skipped: 0, total: 0, durationMs: 0 };
    groups[id][test.status] += 1;
    groups[id].total += 1;
    groups[id].durationMs += test.durationMs ?? 0;
  }
  return groups;
}

/** One printable line: "unit-agent 812, unit-ui-dom 88 (1 failed), ...", largest first. */
export function groupCountsLine(groups) {
  return Object.entries(groups)
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([id, counts]) => {
      const notes = [counts.failed ? `${counts.failed} failed` : "", counts.skipped ? `${counts.skipped} skipped` : ""].filter(Boolean);
      return `${id} ${counts.passed}${notes.length ? ` (${notes.join(", ")})` : ""}`;
    })
    .join(", ");
}

function sumCounts(list) {
  const total = { passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const counts of list) {
    if (!counts) continue;
    total.passed += counts.passed ?? 0;
    total.failed += counts.failed ?? 0;
    total.skipped += counts.skipped ?? 0;
    total.total += counts.total ?? 0;
  }
  return total;
}

/**
 * Build the envelope.
 * steps: [{ label, tier, mode, status, durationMs, counts, log }]
 * tests: per-test rows (unit tiers; e2e rows when a runner provides them)
 * scope: "all" when the run covered the whole suite of its tier, else the files
 */
export function buildRunResult({
  lane,
  args = [],
  command,
  verdict,
  startedAt,
  finishedAt,
  steps,
  tests = [],
  scope = "all",
  cost,
  artifacts = [],
  git: gitFields,
}) {
  const tiers = {};
  for (const entry of steps) {
    const tier = entry.tier ?? "T0";
    tiers[tier] ??= { steps: 0, passed: 0, failed: 0, skipped: 0, total: 0 };
    tiers[tier].steps += 1;
    const counts = entry.counts ?? { passed: 0, failed: 0, skipped: 0, total: 0 };
    tiers[tier].passed += counts.passed ?? 0;
    tiers[tier].failed += counts.failed ?? 0;
    tiers[tier].skipped += counts.skipped ?? 0;
    tiers[tier].total += counts.total ?? 0;
  }
  const modes = new Set(steps.map((entry) => entry.mode ?? (entry.tier === "T0" ? "static" : "scripted")));
  return {
    schema: RUN_RESULT_SCHEMA,
    lane,
    args,
    command,
    mode: modes.has("live") ? "live" : modes.has("scripted") ? "scripted" : "static",
    verdict,
    git: gitFields,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    counts: sumCounts(steps.map((entry) => entry.counts)),
    tiers,
    steps,
    tests,
    scope,
    ...(cost ? { cost } : {}),
    artifacts,
  };
}

/** The compact history line: no per-test passes, only failures and the slowest. */
export function historyLine(envelope) {
  const failed = envelope.tests.filter((test) => test.status === "failed");
  const slowest = [...envelope.tests]
    .filter((test) => test.status === "passed")
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, SLOW_TESTS_KEPT);
  return {
    schema: envelope.schema,
    lane: envelope.lane,
    args: envelope.args,
    mode: envelope.mode,
    verdict: envelope.verdict,
    head: envelope.git?.head ?? null,
    branch: envelope.git?.branch ?? null,
    dirty: envelope.git?.dirty ?? false,
    worktree: envelope.git?.worktree ?? null,
    startedAt: envelope.startedAt,
    durationMs: envelope.durationMs,
    counts: envelope.counts,
    tiers: envelope.tiers,
    steps: envelope.steps.map((entry) => ({
      label: entry.label,
      tier: entry.tier,
      status: entry.status,
      durationMs: entry.durationMs,
    })),
    scope: envelope.scope,
    testCount: envelope.tests.length,
    failedTests: failed.slice(0, FAILED_TESTS_KEPT).map((test) => ({ id: test.id, file: test.file })),
    slowTests: slowest.map((test) => ({ id: test.id, ms: test.durationMs })),
    ...(envelope.cost ? { cost: envelope.cost } : {}),
    artifact: envelope.artifacts[0] ?? null,
  };
}

export function historyPath(cwd = process.cwd()) {
  return path.join(mainWorktreeRoot(cwd), HISTORY_FILE);
}

export function appendHistory(envelope, file = historyPath()) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(historyLine(envelope))}\n`);
  return file;
}

export function readHistory(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn line from a killed run is skipped, not fatal.
    }
  }
  return out;
}

function median(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function covers(entry, file) {
  return entry.scope === "all" || (Array.isArray(entry.scope) && entry.scope.includes(file));
}

/**
 * Read the history into answers: last run per lane, last red per lane, flaky
 * tests (failed and passed on the same head), steps and tests that got slower,
 * and the cost trend of live runs.
 */
export function summarizeHistory(entries, { window = 5 } = {}) {
  const lanes = new Map();
  for (const entry of entries) {
    const list = lanes.get(entry.lane) ?? [];
    list.push(entry);
    lanes.set(entry.lane, list);
  }
  const laneRows = [...lanes.entries()].map(([lane, list]) => {
    const last = list.at(-1);
    const lastRed = [...list].reverse().find((entry) => entry.verdict !== "PASS");
    const passes = list.filter((entry) => entry.verdict === "PASS").length;
    return { lane, runs: list.length, passRate: passes / list.length, last, lastRed };
  });

  // Flaky: a test that failed in one run and passed in another run on the
  // same head. A pass is a run of the same lane with no failures that covered
  // the test's file.
  const flaky = new Map();
  for (const entry of entries) {
    for (const failure of entry.failedTests ?? []) {
      if (!entry.head) continue;
      const passedElsewhere = entries.some(
        (other) =>
          other !== entry &&
          other.head === entry.head &&
          !other.dirty &&
          !entry.dirty &&
          other.verdict === "PASS" &&
          (other.counts?.failed ?? 0) === 0 &&
          covers(other, failure.file),
      );
      if (passedElsewhere) {
        const row = flaky.get(failure.id) ?? { id: failure.id, file: failure.file, heads: new Set(), failures: 0 };
        row.heads.add(entry.head);
        row.failures += 1;
        flaky.set(failure.id, row);
      }
    }
  }

  // Slower steps: median of the last `window` passing runs vs the window before.
  const slowerSteps = [];
  for (const [lane, list] of lanes) {
    const passing = list.filter((entry) => entry.verdict === "PASS");
    const labels = new Set(passing.flatMap((entry) => entry.steps.map((stepRow) => stepRow.label)));
    for (const label of labels) {
      const times = passing
        .map((entry) => entry.steps.find((stepRow) => stepRow.label === label)?.durationMs)
        .filter((value) => typeof value === "number");
      if (times.length < window * 2) continue;
      const recent = median(times.slice(-window));
      const before = median(times.slice(-window * 2, -window));
      if (recent > before * 1.25 && recent - before > 2000) {
        slowerSteps.push({ lane, label, beforeMs: before, recentMs: recent });
      }
    }
  }

  // Slower tests: the latest time vs the median of earlier appearances.
  const testTimes = new Map();
  for (const entry of entries) {
    for (const slow of entry.slowTests ?? []) {
      const list = testTimes.get(slow.id) ?? [];
      list.push(slow.ms);
      testTimes.set(slow.id, list);
    }
  }
  const slowerTests = [];
  for (const [id, times] of testTimes) {
    if (times.length < 3) continue;
    const latest = times.at(-1);
    const before = median(times.slice(0, -1));
    if (latest > before * 1.5 && latest - before > 500) slowerTests.push({ id, beforeMs: before, latestMs: latest });
  }

  const costRuns = entries.filter((entry) => entry.cost && typeof entry.cost.usd === "number");
  return {
    runs: entries.length,
    lanes: laneRows,
    flaky: [...flaky.values()].map((row) => ({ ...row, heads: [...row.heads] })),
    slowerSteps,
    slowerTests: slowerTests.toSorted((a, b) => b.latestMs - b.beforeMs - (a.latestMs - a.beforeMs)),
    cost: costRuns.slice(-10).map((entry) => ({ lane: entry.lane, startedAt: entry.startedAt, usd: entry.cost.usd })),
  };
}
