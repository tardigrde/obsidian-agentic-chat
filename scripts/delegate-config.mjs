#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the config. */
/**
 * Sandbox rules for `scripts/delegate.sh` (opencode reviewers and researchers).
 * A delegate is read-only with one writable file; the lead agent implements
 * (#393 T26).
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

const SECRET_PATHS = ["*.env", "*.env.*", "*auth.json"];

/**
 * Files that make git or npm run code. A delegate that could edit `.git` (a file
 * in a worktree) pointed it at a fake git dir with `core.fsmonitor` set to its
 * own script, so every allowed `git status` ran any command (2026-11-13).
 * These denies come after the edit allow, so they win.
 */
const EXEC_CONFIG_PATHS = [
  ".git", "*/.git", ".git/*", "*/.git/*",
  ".gitmodules", "*/.gitmodules", ".gitattributes", "*/.gitattributes",
  ".npmrc", "*/.npmrc",
  // node_modules is a link to the main checkout: an edit there runs in every lane.
  "node_modules/*", "*/node_modules/*",
];

/**
 * Command-line git config for every delegate run (`GIT_CONFIG_COUNT` beats the
 * repository config): no fsmonitor hook and no repository hooks.
 */
export function gitGuardEnv() {
  const pairs = [
    ["core.fsmonitor", "false"],
    ["core.hooksPath", "/dev/null"],
  ];
  const env = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

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

/**
 * Patterns that beat any allow: output redirection (writes past the edit rule),
 * `git diff --no-index` (prints any file on disk), `--output` (writes a file),
 * and `--fix` / `-u` (rewrite files).
 */
const SHELL_DENY = ["*>*", "*--no-index*", "*--output*", "*--outFile*", "*--outDir*", "* -o *", "* -o", "*--fix*", "* -u*", "*--update*"];

const rule = (action, resource, effect) => ({ action, resource, effect });

/**
 * @param {{ mode: "review", main: string, edit: string }} options
 *   `edit` is the one file the delegate may write (a verdict or a research
 *   report), relative to the directory it runs in.
 */
export function delegatePermissions({ mode, main, edit }) {
  if (mode !== "review") throw new Error("a delegate is read-only: mode must be review");
  const rules = [rule("*", "*", "deny")];
  for (const action of ["read", "glob", "grep", "list", "todowrite", "todoread"]) rules.push(rule(action, "*", "allow"));
  // The grep tool reads file content too, so the secret deny covers it as well as read.
  for (const action of ["read", "grep"]) for (const path of SECRET_PATHS) rules.push(rule(action, path, "deny"));
  rules.push(rule("external_directory", `${main}/node_modules/*`, "allow"));
  rules.push(rule("external_directory", `${main}/.obsidian-cache/*`, "allow"));
  rules.push(rule("edit", edit, "allow"));
  for (const path of EXEC_CONFIG_PATHS) rules.push(rule("edit", path, "deny"));
  for (const command of READ_SHELL) rules.push(rule("shell", command, "allow"));
  for (const pattern of SHELL_DENY) rules.push(rule("shell", pattern, "deny"));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "permissions") {
    const [mode, main, edit] = args;
    console.log(JSON.stringify({ permissions: delegatePermissions({ mode, main, edit }) }));
  } else if (command === "git-env") {
    // Shell `export` lines for scripts/delegate.sh.
    for (const [key, value] of Object.entries(gitGuardEnv())) console.log(`export ${key}=${JSON.stringify(value)}`);
  } else {
    throw new Error("usage: delegate-config.mjs permissions review <main> <edit> | git-env");
  }
}
