#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the config or one verdict state. */
/**
 * Sandbox rules for `scripts/delegate.sh` (opencode workers and reviewers).
 *
 * OpenCode V2 `permissions`: an ordered list, the last matching rule wins, and
 * `*` matches any characters including `/` and spaces. So the catch-all deny
 * comes first, then narrow allows, then the denies that must beat an allow.
 *
 * Known limit: allowed commands such as `npm run verify` and `npx vitest` run
 * repository code. The sandbox stops mistakes and injected tool calls; it is not
 * a boundary against a malicious repository.
 */
import { pathToFileURL } from "node:url";
import { parseVerdict } from "./check-review-gate.mjs";

const SECRET_PATHS = ["*.env", "*.env.*", "*auth.json"];

/** Read-only shell commands. None of them can print an untracked file. */
const READ_SHELL = [
  "git status *",
  "git diff *",
  "git log *",
  "git show *",
  "git rev-parse *",
  "npx vitest *",
  "npm run verify *",
  "npm run verify:*",
  "node scripts/verify.mjs *",
  "node scripts/verify-witness.mjs *",
  "npm ls *",
  "gh pr view *",
  "gh pr diff *",
  "ls *",
  "wc *",
];

/** Extra commands a worker needs to build and commit. */
const WORK_SHELL = ["git add *", "git commit *", "git stash *", "npx tsc *", "npx eslint *", "npm run lint *", "npm run typecheck *"];

/**
 * Patterns that beat any allow: output redirection (writes past the edit rule),
 * `git diff --no-index` (prints any file on disk), `--output` (writes a file),
 * and `--fix` (rewrites files) for a reviewer.
 */
const SHELL_DENY = ["*>*", "*--no-index*", "*--output*"];
const REVIEW_SHELL_DENY = ["*--fix*", "* -u*", "*--update*"];

const rule = (action, resource, effect) => ({ action, resource, effect });

/**
 * @param {{ mode: "work" | "review", main: string, edit: string }} options
 *   `edit` is relative to the worktree: `*` for a worker, the verdict path for a reviewer.
 */
export function delegatePermissions({ mode, main, edit }) {
  const rules = [rule("*", "*", "deny")];
  for (const action of ["read", "glob", "grep", "list", "todowrite", "todoread"]) rules.push(rule(action, "*", "allow"));
  // The grep tool reads file content too, so the secret deny covers it as well as read.
  for (const action of ["read", "grep"]) for (const path of SECRET_PATHS) rules.push(rule(action, path, "deny"));
  rules.push(rule("external_directory", `${main}/node_modules/*`, "allow"));
  rules.push(rule("external_directory", `${main}/.obsidian-cache/*`, "allow"));
  rules.push(rule("edit", edit, "allow"));
  for (const command of mode === "work" ? [...READ_SHELL, ...WORK_SHELL] : READ_SHELL) rules.push(rule("shell", command, "allow"));
  for (const pattern of mode === "work" ? SHELL_DENY : [...SHELL_DENY, ...REVIEW_SHELL_DENY]) rules.push(rule("shell", pattern, "deny"));
  return rules;
}

/**
 * Matches an OpenCode V2 wildcard: `*` is any run of characters, `?` one
 * character, and a pattern ending in " *" also matches the bare command.
 */
export function wildcardMatch(pattern, value) {
  if (pattern.endsWith(" *") && value === pattern.slice(0, -2)) return true;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]");
  return new RegExp(`^${source}$`).test(value);
}

/** The effect OpenCode applies: the last matching rule, or `ask` when none matches. */
export function decide(rules, action, resource) {
  let effect = "ask";
  for (const entry of rules) {
    if (wildcardMatch(entry.action, action) && wildcardMatch(entry.resource, resource)) effect = entry.effect;
  }
  return effect;
}

/** True when the last verdict (by order) in these comment bodies is a FAIL, as the gate parses it. */
export function lastVerdictIsFail(bodies) {
  const verdicts = bodies.map((body) => parseVerdict(body)).filter(Boolean);
  return verdicts.length > 0 && verdicts[verdicts.length - 1].verdict === "FAIL";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "permissions") {
    const [mode, main, edit] = args;
    if (mode !== "work" && mode !== "review") throw new Error("mode must be work or review");
    console.log(JSON.stringify({ permissions: delegatePermissions({ mode, main, edit }) }));
  } else if (command === "fail") {
    // stdin: JSON array of comment bodies, oldest first.
    // Exit 0: the last verdict is FAIL. 1: it is not. 2: the input is unreadable (treat as FAIL).
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      let bodies;
      try {
        bodies = JSON.parse(input);
      } catch {
        process.exit(2);
      }
      if (!Array.isArray(bodies)) process.exit(2);
      process.exit(lastVerdictIsFail(bodies.map(String)) ? 0 : 1);
    });
  } else {
    throw new Error("usage: delegate-config.mjs permissions <work|review> <main> <edit> | fail < bodies.json");
  }
}
