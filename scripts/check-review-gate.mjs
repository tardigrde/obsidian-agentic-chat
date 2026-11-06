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
 *   Fast lane: <result>
 *
 * The comment must be at the current head. A different GitHub account is
 * preferred. On a single-account repository, set REVIEW_GATE_SINGLE_ACCOUNT=1
 * and keep the separate-agent rule in the process, not in GitHub.
 */

const LIMITS = { changedLines: 400, changedFiles: 10 };
const GENERATED = [
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /\.min\.(?:js|css)$/,
  /^coverage\//,
  /^logs\//,
];

export function isGeneratedFile(file) {
  const paths = String(file).split(" => ");
  return paths.some((candidate) => GENERATED.some((pattern) => pattern.test(candidate)));
}

export function parseVerdict(body) {
  const text = String(body ?? "");
  const verdict = /^\**Verdict:\s*(PASS(?:\+NOTES)?|FAIL)\**\s*$/m.exec(text)?.[1] ?? null;
  const head = /^\**Head:\s*`?([0-9a-f]{7,40})`?\**\s*$/m.exec(text)?.[1] ?? null;
  const reviewer = /^\**Reviewer:\s*(.+?)\s*\**\s*$/m.exec(text)?.[1]?.trim() ?? null;
  const hasFastLane = /^\**Fast lane:/m.test(text);
  if (!verdict || !head || !reviewer || !hasFastLane) return null;
  return { verdict, head, reviewer };
}

function headMatches(reviewed, current) {
  return reviewed.length >= 7 && current.startsWith(reviewed);
}

export function sizeErrors({ changedLines, changedFiles, labels = [] }) {
  if (labels.map((label) => label.toLowerCase()).includes("large-pr")) return [];
  const errors = [];
  if (changedLines > LIMITS.changedLines) {
    errors.push(
      `this PR changes ${changedLines} lines; the limit is ${LIMITS.changedLines} (add the large-pr label to override)`,
    );
  }
  if (changedFiles > LIMITS.changedFiles) {
    errors.push(
      `this PR changes ${changedFiles} files; the limit is ${LIMITS.changedFiles} (add the large-pr label to override)`,
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
}) {
  const errors = [];
  const normalizedAuthor = String(author ?? "").toLowerCase();
  const candidates = comments
    .map((comment) => ({ ...comment, parsed: parseVerdict(comment.body) }))
    .filter((comment) => comment.parsed)
    .filter((comment) => headMatches(comment.parsed.head, headSha))
    .filter(
      (comment) =>
        singleAccount || String(comment.author ?? "").toLowerCase() !== normalizedAuthor,
    )
    .sort((left, right) => String(left.updatedAt ?? "").localeCompare(String(right.updatedAt ?? "")));
  const latest = candidates.at(-1);

  if (!latest) {
    errors.push(
      `no verdict at head ${headSha.slice(0, 7)}; post a comment with Verdict, Head, Reviewer, and Fast lane from the independent reviewer`,
    );
  } else if (latest.parsed.verdict === "FAIL") {
    errors.push("the latest verdict at this head is FAIL");
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

function parseNumstat(output) {
  let changedLines = 0;
  let changedFiles = 0;
  for (const line of String(output).split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, file] = line.split("\t");
    if (!file || isGeneratedFile(file)) continue;
    changedFiles += 1;
    changedLines += (Number(added) || 0) + (Number(deleted) || 0);
  }
  return { changedLines, changedFiles };
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
    body: item.body ?? "",
    updatedAt: item.updated_at ?? item.submitted_at ?? item.created_at ?? "",
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
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== pull.head.sha) {
    console.error(`review gate: checked out ${head.slice(0, 7)}, API head is ${pull.head.sha.slice(0, 7)}`);
    process.exitCode = 1;
    return;
  }

  const [issueComments, reviews] = await Promise.all([
    apiAll(`/repos/${repository}/issues/${number}/comments`, token),
    apiAll(`/repos/${repository}/pulls/${number}/reviews`, token),
  ]);
  const comments = [...issueComments, ...reviews].map(normalizeComment);
  const diff = execFileSync("git", ["diff", "--numstat", `${pull.base.sha}...${head}`], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const size = parseNumstat(diff);
  const result = reviewGate({
    comments,
    author: pull.user?.login,
    headSha: head,
    changedLines: size.changedLines,
    changedFiles: size.changedFiles,
    labels: (pull.labels ?? []).map((label) => label.name),
    singleAccount: process.env.REVIEW_GATE_SINGLE_ACCOUNT === "1",
  });

  console.log(
    `review gate: ${result.ok ? "PASS" : "FAIL"} (${size.changedFiles} files, ${size.changedLines} lines, ${result.commentsAtHead} verdict(s) at this head)`,
  );
  if (result.verdict) console.log(`  verdict: ${result.verdict} by ${result.reviewer}`);
  if (!result.ok) {
    printErrors(result.errors);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`review gate: ${error.message}`);
    process.exitCode = 1;
  });
}
