#!/usr/bin/env node
/* eslint-disable no-console -- CLI checker prints its findings. */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { groupFor, listTestFiles, loadManifest } from "./check-test-manifest.mjs";

/**
 * The skip rule (#393 D8, rule 3). In the deterministic tiers (T1 unit, T2
 * real app with scripted turns) a test never goes green by skipping. The one
 * escape hatch is a skip whose title starts with `flaky #<issue>: `, and that
 * issue must be open. Live (T3) and exploration (T4) suites may gate on env.
 *
 * Offline the checker validates the format. With `--online` (default in CI
 * when a token is present) it also asks GitHub that each issue is open.
 */

const DETERMINISTIC_TIERS = new Set(["T1", "T2"]);
const FLAKY_TITLE = /^\s*(["'`])flaky #(\d+): \S[^\n]*?\1/;
const SKIP_CALLS = [
  { kind: "skip", pattern: /\b(?:it|test|describe|suite|context)\.skip\s*\(/g, titled: true },
  { kind: "skipIf", pattern: /\b(?:it|test|describe|suite)\.(?:skipIf|runIf)\s*\(/g, titled: false },
  { kind: "todo", pattern: /\b(?:it|test|describe)\.todo\s*\(/g, titled: false },
  { kind: "this.skip", pattern: /\bthis\.skip\s*\(/g, titled: false },
  { kind: "ctx.skip", pattern: /\bctx\.skip\s*\(/g, titled: false },
  { kind: "xit", pattern: /(?<![\w.])x(?:it|describe)\s*\(/g, titled: false },
  { kind: "skip alias", pattern: /\?\s*(?:it|test|describe)\s*:\s*(?:it|test|describe)\.skip\b/g, titled: false },
];

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Every skip in a source text, with the flaky issue number when the title has one. */
export function findSkips(text) {
  const found = [];
  const seen = new Set();
  for (const call of SKIP_CALLS) {
    for (const match of text.matchAll(call.pattern)) {
      const index = match.index ?? 0;
      if (seen.has(index)) continue;
      seen.add(index);
      const after = text.slice(index + match[0].length);
      const flaky = call.titled ? FLAKY_TITLE.exec(after) : null;
      found.push({
        line: lineOf(text, index),
        kind: call.kind,
        issue: flaky ? Number(flaky[2]) : null,
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

export function checkSkips({ manifest, files, read }) {
  const errors = [];
  const flaky = [];
  for (const file of files) {
    const group = groupFor(manifest, file);
    if (!group || !DETERMINISTIC_TIERS.has(group.tier)) continue;
    for (const skip of findSkips(read(file))) {
      if (skip.issue !== null) {
        flaky.push({ file, line: skip.line, issue: skip.issue });
        continue;
      }
      errors.push(
        `${file}:${skip.line} ${skip.kind} in a ${group.tier} test. Fix it, delete it, or write ` +
          '`it.skip("flaky #<open issue>: <reason>", ...)`.',
      );
    }
  }
  return { errors, flaky };
}

async function issueState(repo, issue, token) {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "agentic-chat-check-skips",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) return `unreadable (HTTP ${response.status})`;
  const body = await response.json();
  return body.state;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: node scripts/check-skips.mjs [--online]\n\n" +
        'T1/T2 tests may only skip as `it.skip("flaky #<open issue>: ...")`. --online checks the issue is open.',
    );
    return;
  }
  const root = process.cwd();
  const manifest = loadManifest(root);
  const files = listTestFiles(manifest, root);
  const { errors, flaky } = checkSkips({
    manifest,
    files,
    read: (file) => readFileSync(path.join(root, file), "utf8"),
  });

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const online = process.argv.includes("--online") || (process.env.CI === "true" && Boolean(token));
  if (online) {
    const repo = process.env.GITHUB_REPOSITORY ?? "tardigrde/obsidian-agentic-chat";
    for (const entry of flaky) {
      const state = await issueState(repo, entry.issue, token);
      if (state !== "open") errors.push(`${entry.file}:${entry.line} names flaky #${entry.issue}, which is ${state}`);
    }
  }

  if (errors.length > 0) {
    console.error(`skip rule: FAIL (${errors.length} error(s))`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  const mode = online ? "issues checked online" : "format only; --online checks the issues";
  console.log(`skip rule: PASS (${files.length} files, ${flaky.length} flaky skip(s), ${mode})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
