#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the gate summary and every error. */
import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * Require an independent verdict comment and keep pull requests small.
 *
 * A verdict is a comment that contains all of:
 *   Verdict: PASS | PASS+NOTES | FAIL
 *   Head: <commit>
 *   Reviewer: <agent/session>
 *   Fast lane: <result with a test count, e.g. "PASS (1702 passed, 173 files)">,
 *              or "CI ..." when the gate itself sees the ci and e2e checks pass at the head
 *
 * The comment must be at the current head and come from an OWNER, MEMBER, or
 * COLLABORATOR account that is not a bot. A FAIL is sticky: only a later PASS
 * from a different Reviewer clears it. Comments are ordered by creation time,
 * so editing an old comment does not move it. A different GitHub account is
 * preferred. On a single-account repository, set REVIEW_GATE_SINGLE_ACCOUNT=1
 * and keep the separate-agent rule in the process, not in GitHub.
 */

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const FAST_LANE_COUNT = /\b\d+\s+passed\b/i;
/** "Fast lane: CI ..." cites CI instead of a local run; the gate checks CI itself. */
const FAST_LANE_CI = /^CI\b/;

/** Added lines and touched files under `src/`. See measureNumstat. */
const LIMITS = { changedLines: 1000, changedFiles: 25 };
const GENERATED = [
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /\.min\.(?:js|css)$/,
  /^coverage\//,
  /^logs\//,
];

/** One path from `git diff --numstat -z` (never a rename pair). */
export function isGeneratedFile(file) {
  const path = String(file);
  return GENERATED.some((pattern) => pattern.test(path));
}

export function parseVerdict(body) {
  const text = String(body ?? "");
  const field = (name) => {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine
        .trim()
        .replace(/^\*+/, "")
        .replace(/\*+$/, "")
        .trim();
      if (!line.toLowerCase().startsWith(`${name.toLowerCase()}:`)) continue;
      return line.slice(name.length + 1).trim();
    }
    return null;
  };
  const verdict = field("Verdict");
  const head = field("Head")?.replaceAll("`", "").trim() ?? null;
  const reviewer =
    field("Reviewer")
      ?.replace(/[^\w .@:/-]/g, "")
      .slice(0, 80) || null;
  const fastLane = field("Fast lane") ?? "";
  const citesCi = !FAST_LANE_COUNT.test(fastLane) && FAST_LANE_CI.test(fastLane);
  const hasFastLane = FAST_LANE_COUNT.test(fastLane) || citesCi;
  if (!/^(?:PASS(?:\+NOTES)?|FAIL)$/.test(verdict ?? "")) return null;
  if (!/^[0-9a-f]{7,40}$/.test(head ?? "")) return null;
  if (!reviewer || !hasFastLane) return null;
  return { verdict, head, reviewer, citesCi };
}

function isTrustedAuthor(comment) {
  if (String(comment.authorType ?? "").toLowerCase() === "bot") return false;
  if (/\[bot\]$/i.test(String(comment.author ?? ""))) return false;
  return TRUSTED_ASSOCIATIONS.has(String(comment.authorAssociation ?? "").toUpperCase());
}

function sameReviewer(left, right) {
  return left.parsed.reviewer.toLowerCase() === right.parsed.reviewer.toLowerCase();
}

function headMatches(reviewed, current) {
  return reviewed.length >= 7 && current.startsWith(reviewed);
}

export function sizeErrors({ changedLines, changedFiles, labels = [] }) {
  if (labels.map((label) => label.toLowerCase()).includes("large-pr")) return [];
  const errors = [];
  if (changedLines > LIMITS.changedLines) {
    errors.push(
      `this PR adds ${changedLines} lines under src/; the limit is ${LIMITS.changedLines} (add the large-pr label to override)`,
    );
  }
  if (changedFiles > LIMITS.changedFiles) {
    errors.push(
      `this PR adds code to ${changedFiles} files under src/; the limit is ${LIMITS.changedFiles} (add the large-pr label to override)`,
    );
  }
  return errors;
}

export function reviewGate({
  comments,
  author,
  headSha,
  changedLines,
  changedFiles,
  labels = [],
  singleAccount = false,
  ciGreen = false,
}) {
  const errors = [];
  const normalizedAuthor = String(author ?? "").toLowerCase();
  const candidates = comments
    .map((comment) => ({ ...comment, parsed: parseVerdict(comment.body) }))
    .filter((comment) => comment.parsed)
    .filter((comment) => headMatches(comment.parsed.head, headSha))
    .filter(isTrustedAuthor)
    .filter(
      (comment) =>
        singleAccount || String(comment.author ?? "").toLowerCase() !== normalizedAuthor,
    )
    // Creation time, not update time: editing an old comment must not reorder it.
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
  const isPass = (comment) => comment.parsed.verdict !== "FAIL";
  const later = (comment, other) =>
    String(comment.createdAt ?? "") > String(other.createdAt ?? "");
  // A FAIL is sticky: only a later PASS from a different Reviewer clears it.
  const openFail = candidates.find(
    (failed) =>
      !isPass(failed) &&
      !candidates.some((other) => isPass(other) && later(other, failed) && !sameReviewer(other, failed)),
  );
  const latest = openFail ?? candidates.at(-1);

  if (!latest) {
    errors.push(
      `no verdict at head ${headSha.slice(0, 7)}; post a comment with Verdict, Head, Reviewer, and Fast lane (with a "N passed" count) from a trusted independent reviewer`,
    );
  } else if (openFail) {
    errors.push(
      `a FAIL verdict at this head by ${openFail.parsed.reviewer} is not cleared; only a later PASS from a different Reviewer clears it`,
    );
  } else if (latest.parsed.citesCi && !ciGreen) {
    errors.push(
      `the verdict at head ${headSha.slice(0, 7)} cites CI, but the ci and e2e checks have not both passed at this head`,
    );
  }

  errors.push(...sizeErrors({ changedLines, changedFiles, labels }));
  return {
    ok: errors.length === 0,
    errors,
    verdict: latest?.parsed.verdict ?? null,
    reviewer: latest?.parsed.reviewer ?? null,
    commentsAtHead: candidates.length,
  };
}

/**
 * The size budget measures risky code only (#288): lines added under `src/`.
 * Deleted lines, tests, docs, skills, generated files, and lockfiles are free,
 * so a removal or a docs sweep does not need the `large-pr` override.
 */
const BUDGETED_PREFIX = "src/";

/**
 * Size of a `git diff --numstat -z` output against the budget. With `-z`, git
 * never quotes a path and never mixes `=>` into it: a normal record is
 * `added\tdeleted\tpath\0`; a rename is `added\tdeleted\t\0old\0new\0`.
 * Only the destination path is judged, so a file moved into `src/` counts its
 * added lines. Binary files (`-`) add nothing.
 */
export function measureNumstat(output) {
  const tokens = String(output).split("\0");
  let changedLines = 0;
  let changedFiles = 0;
  let index = 0;
  while (index < tokens.length) {
    const record = tokens[index++];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (secondTab === -1) continue;
    const added = Number(record.slice(0, firstTab)) || 0;
    let destination = record.slice(secondTab + 1);
    if (destination === "") {
      index += 1; // rename source
      destination = tokens[index++] ?? "";
    }
    if (!destination.startsWith(BUDGETED_PREFIX) || isGeneratedFile(destination)) continue;
    if (added === 0) continue;
    changedFiles += 1;
    changedLines += added;
  }
  return { changedLines, changedFiles };
}

/** Run `git diff --numstat -z base...head` in `cwd`. */
export function readNumstat(base, head, cwd = process.cwd()) {
  return execFileSync( // NOSONAR:S6350 -- base and head SHAs are validated by the caller.
    "git", // NOSONAR:S4036 -- git is the repository tool, resolved from PATH in CI.
    ["diff", "--numstat", "-z", "-M", `${base}...${head}`],
    { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
}

async function api(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function apiAll(path, token) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await api(`${path}${separator}per_page=100&page=${page}`, token);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

function normalizeComment(item) {
  return {
    author: item.user?.login ?? "",
    authorType: item.user?.type ?? "",
    authorAssociation: item.author_association ?? "",
    body: item.body ?? "",
    createdAt: item.created_at ?? item.submitted_at ?? "",
  };
}

function printErrors(errors) {
  for (const error of errors) console.error(`  ${error}`);
}

async function main() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const number = process.env.PR_NUMBER;
  if (!token || !repository || !number) {
    console.error("review gate: GH_TOKEN, GITHUB_REPOSITORY, and PR_NUMBER are required");
    process.exitCode = 1;
    return;
  }

  const pull = await api(`/repos/${repository}/pulls/${number}`, token);
  const fullSha = /^[0-9a-f]{40}$/;
  if (!fullSha.test(pull.head.sha) || !fullSha.test(pull.base.sha)) {
    console.error("review gate: GitHub returned an invalid commit SHA");
    process.exitCode = 1;
    return;
  }
  const head = execFileSync(
    "git", // NOSONAR:S4036 -- git is the repository tool, resolved from PATH in CI.
    ["rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  if (head !== pull.head.sha) {
    console.error("review gate: checked out head does not match the API head");
    process.exitCode = 1;
    return;
  }

  const [issueComments, reviews] = await Promise.all([
    apiAll(`/repos/${repository}/issues/${number}/comments`, token),
    apiAll(`/repos/${repository}/pulls/${number}/reviews`, token),
  ]);
  const comments = [...issueComments, ...reviews].map(normalizeComment);
  // A verdict may cite CI instead of a local fast lane; the gate checks CI itself.
  const checkRuns = await api(`/repos/${repository}/commits/${head}/check-runs?per_page=100`, token);
  const passed = new Set(
    (checkRuns.check_runs ?? [])
      // Only GitHub Actions jobs: a third-party app could report a check named "ci".
      .filter((run) => run.app?.slug === "github-actions")
      .filter((run) => run.status === "completed" && run.conclusion === "success")
      .map((run) => run.name),
  );
  const ciGreen = passed.has("ci") && passed.has("e2e");
  const base = pull.base.sha;
  const diff = readNumstat(base, head);
  const size = measureNumstat(diff);
  const result = reviewGate({
    comments,
    author: pull.user?.login,
    headSha: head,
    changedLines: size.changedLines,
    changedFiles: size.changedFiles,
    labels: (pull.labels ?? []).map((label) => label.name),
    singleAccount: process.env.REVIEW_GATE_SINGLE_ACCOUNT === "1",
    ciGreen,
  });

  console.log(
    `review gate: ${result.ok ? "PASS" : "FAIL"} (src/ budget: ${size.changedFiles} files, ${size.changedLines} added lines, ${result.commentsAtHead} verdict(s) at this head)`,
  );
  if (result.verdict) console.log(`  verdict: ${result.verdict} by ${result.reviewer}`);
  if (!result.ok) {
    printErrors(result.errors);
    process.exitCode = 1;
  }
  if (process.env.GITHUB_EVENT_NAME === "issue_comment") {
    console.log(
      "  note: this run was triggered by a comment and attaches to the default branch, not the PR head. Re-trigger the PR's review check (for example, edit the PR body) so the required check updates.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`review gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
