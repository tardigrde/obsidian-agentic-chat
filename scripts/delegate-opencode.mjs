#!/usr/bin/env node
// Writes the OpenCode job state and its findings for one PR head to a file. An empty
// list means "no findings" only when the first line says `pass`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

export const JOB = "opencode-review";
const BOT = "github-actions[bot]";
const MISSING_GRACE_SECONDS = 60;

export function jobState(checks) {
  if (!Array.isArray(checks)) return "unknown";
  const check = checks.find((entry) => entry.name === JOB || entry.name?.endsWith(` / ${JOB}`));
  if (!check) return "missing";
  if (check.bucket === "pass") return "pass";
  if (check.bucket === "fail" || check.bucket === "cancel") return "failed";
  if (check.bucket === "skipping") return "skipped";
  return "pending";
}

export function findingsFor(comments, head) {
  return comments
    .filter((comment) => comment.login === BOT && comment.commit_id === head)
    .map((comment) => `- ${comment.path}:${comment.line ?? comment.original_line ?? "?"} ${String(comment.body).replaceAll("\n", " ")}`);
}

export function render(state, findings, waitedSeconds = 0) {
  const lines = [`OpenCode job: ${state}`];
  if (state === "pass") {
    lines.push(...(findings.length > 0 ? findings : ["No findings: the job passed and posted none."]));
  } else if (state === "failed") {
    lines.push("The job failed or was cancelled. The findings were NOT read. Say so in the verdict; this is not 'no findings'.");
  } else if (state === "skipped") {
    lines.push("The job was skipped (draft, fork, or bot PR), so no findings exist. Mark the PR ready first if a finder run is wanted.");
  } else if (state === "pending") {
    lines.push(`The job was still running after ${waitedSeconds}s. The findings were NOT read. Say so in the verdict.`);
  } else if (state === "missing") {
    lines.push("No OpenCode job ran on this head. The findings were NOT read. Say so in the verdict.");
  } else {
    lines.push("The check status could not be read (gh failed). The findings were NOT read. Say so in the verdict.");
  }
  return `${lines.join("\n")}\n`;
}

export async function waitForJob(readChecks, { waitSeconds, intervalSeconds, sleep = (seconds) => delay(seconds * 1000) }) {
  let waited = 0;
  let state = jobState(readChecks());
  while (waited < waitSeconds && (state === "pending" || (state === "missing" && waited < MISSING_GRACE_SECONDS))) {
    await sleep(intervalSeconds);
    waited += intervalSeconds;
    state = jobState(readChecks());
  }
  return { state, waited };
}

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); // NOSONAR:S4036 -- gh from PATH.
  return result.error ? { status: 1, stdout: "" } : { status: result.status, stdout: result.stdout ?? "" };
}

function readChecks(pr) {
  // `gh pr checks` exits 8 while a check is pending but still prints the JSON.
  const { stdout } = gh(["pr", "checks", pr, "--json", "name,bucket"]);
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function readComments(pr) {
  const jq = ".[] | {login: .user.login, commit_id, path, line, original_line, body}";
  const { status, stdout } = gh(["api", "--paginate", `repos/{owner}/{repo}/pulls/${pr}/comments`, "--jq", jq]);
  if (status !== 0) return null;
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

async function main(args) {
  const [pr, out] = args;
  const head = option(args, "--head");
  if (!pr || !out || !head) {
    process.stderr.write("usage: node scripts/delegate-opencode.mjs <pr> <out-file> --head <sha> [--wait <s>] [--interval <s>]\n");
    process.exitCode = 2;
    return;
  }
  const waitSeconds = Number(option(args, "--wait", process.env.DELEGATE_OPENCODE_WAIT ?? 600));
  const intervalSeconds = Number(option(args, "--interval", 20));
  const { state, waited } = await waitForJob(() => readChecks(pr), { waitSeconds, intervalSeconds });
  const comments = state === "pass" ? readComments(pr) : [];
  const settled = comments === null ? "unknown" : state;
  fs.writeFileSync(out, render(settled, settled === "pass" ? findingsFor(comments, head) : [], waited));
  if (settled !== "pass") process.stderr.write(`delegate: OpenCode job is ${settled}; the reviewer is told the findings were not read.\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main(process.argv.slice(2));
