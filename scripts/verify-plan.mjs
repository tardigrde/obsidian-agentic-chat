#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the plan. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { groupFor, listTestFiles, loadManifest } from "./check-test-manifest.mjs";
import { matchesAny } from "./lib/glob.mjs";

/**
 * `npm run verify -- plan`: read the diff, match test/manifest.json triggers,
 * and print the exact commands this change needs, cheapest first.
 *
 * Advisory: it is the first command an agent runs, not a CI gate. It never
 * plans less than `check`, and a src/ path no trigger knows falls back to the
 * unit tier plus the app tier.
 */

const MAX_RELATED_TESTS = 6;
const BIG_CHANGE_SRC_FILES = 15;

function sh(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" }); // NOSONAR:S4036 -- git from PATH.
  return result.status === 0 ? result.stdout : null;
}

export function defaultBase(cwd = process.cwd()) {
  for (const ref of ["origin/main", "main"]) {
    if (sh(["rev-parse", "--verify", "--quiet", ref], cwd) !== null) return ref;
  }
  return "HEAD";
}

/** Committed changes since the merge base plus uncommitted and untracked files. */
export function changedFiles(base, cwd = process.cwd()) {
  const lists = [
    sh(["diff", "--name-only", "--no-renames", `${base}...HEAD`], cwd),
    sh(["diff", "--name-only", "--no-renames", "HEAD"], cwd),
    sh(["ls-files", "--others", "--exclude-standard"], cwd),
  ];
  const files = new Set();
  for (const list of lists) for (const line of (list ?? "").split("\n")) if (line.trim()) files.add(line.trim());
  return [...files].sort();
}

function stem(file) {
  return path.basename(file).replace(/\.(test|e2e|dogfood|eval)?\.?[cm]?[jt]sx?$/, "").replace(/\.d$/, "");
}

/** Unit tests whose name starts with the source file's stem (chat-view.ts -> chat-view-*.test.ts). */
export function relatedUnitTests(file, unitTests) {
  const name = stem(file);
  if (name.length < 3) return [];
  return unitTests.filter((test) => {
    const testName = path.basename(test, ".test.ts");
    return testName === name || testName.startsWith(`${name}-`) || name.startsWith(`${testName}-`);
  });
}

function command(id, cmd, { budgetSeconds, why, needs = {}, live = false }) {
  return { id, command: cmd, budgetSeconds, why, needs, live };
}

/**
 * Build the plan for a list of changed paths. Pure: no git, no filesystem
 * beyond what the caller passes, so fixture diffs can pin it.
 */
export function planFor(files, manifest, testFiles, exists = () => true) {
  const unitTests = testFiles.filter((file) => groupFor(manifest, file)?.runner === "vitest" && groupFor(manifest, file)?.tier === "T1");
  const steps = new Map();
  const explain = [];
  const add = (step) => {
    if (!steps.has(step.id)) steps.set(step.id, step);
  };
  const changeTargets = new Set();
  const appSpecs = new Set();
  let appFull = false;
  let srcCount = 0;

  for (const file of files) {
    const reasons = [];
    const ownGroup = groupFor(manifest, file);
    if (ownGroup && !exists(file)) {
      reasons.push(`a deleted ${ownGroup.tier} test from ${ownGroup.id}; its group still runs in check/CI`);
    } else if (ownGroup) {
      reasons.push(`is a ${ownGroup.tier} test in ${ownGroup.id}`);
      if (ownGroup.id.startsWith("unit-")) changeTargets.add(file);
      if (ownGroup.id === "app-specs" || ownGroup.id === "app-smoke") appSpecs.add(file);
    }
    const triggered = manifest.groups.filter((group) => matchesAny(file, group.triggers));
    for (const group of triggered) reasons.push(`triggers ${group.id}`);

    if (file.startsWith("src/")) {
      srcCount += 1;
      if (triggered.length === 0) {
        reasons.push("matches no trigger: fall back to unit + app");
        appFull = true;
      }
    }
    const related = ownGroup ? [] : relatedUnitTests(file, unitTests).slice(0, MAX_RELATED_TESTS);
    for (const test of related) {
      if (test !== file) {
        changeTargets.add(test);
        reasons.push(`related unit test ${test}`);
      }
    }

    for (const group of triggered) {
      if (group.id === "app-specs" || group.id === "app-smoke") {
        if (!file.startsWith("test/e2e/specs/")) appFull = true;
      } else if (group.id === "app-mobile") {
        add(command("app-mobile", "npm run verify -- app --mobile", {
          budgetSeconds: group.budgetSeconds, why: "the chat at a 390 px viewport", needs: group.needs,
        }));
      } else if (group.id === "app-dogfood-scripted") {
        add(command("app-dogfood", "npm run verify -- app --dogfood", {
          budgetSeconds: group.budgetSeconds, why: "the scripted dogfood vault and its invariants; production imports", needs: group.needs,
        }));
      } else if (group.id === "eval-tool-use") {
        add(command("eval-core", "npm run verify -- eval --suite core --runs 3", {
          budgetSeconds: group.budgetSeconds, why: "a prompt, tool, or agent change: tool choice and cost vs the baseline", needs: group.needs, live: true,
        }));
      } else if (group.id === "live-e2e" || group.id === "live-unit") {
        add(command(`live-${group.id}`, group.command.replace("<spec>", "").trim(), {
          budgetSeconds: group.budgetSeconds, why: group.why, needs: group.needs, live: true,
        }));
      }
    }
    if (file.startsWith("docs/")) {
      add(command("docs-build", "npm run docs:build", { budgetSeconds: 40, why: "the docs site builds and its links resolve" }));
    }
    if (file === "package.json" || file === "package-lock.json") appFull = true;
    explain.push({ file, reasons });
  }

  if (changeTargets.size > 0) {
    const targets = [...changeTargets].sort();
    add(command("change:", `npm run verify -- change ${targets.join(" ")}`, {
      budgetSeconds: Math.min(30, 3 + 2 * targets.length),
      why: "the unit tests closest to this change (the witness loop)",
    }));
  }
  add(command("check", "npm run verify -- check", {
    budgetSeconds: 60,
    why: "the merge gate (static, unit, build, smoke); always required",
    needs: { display: true },
  }));
  if (appFull) {
    add(command("app", "npm run verify -- app", {
      budgetSeconds: 110, why: "a product or dependency change: the full real-Obsidian suite", needs: { display: true },
    }));
  } else {
    for (const spec of [...appSpecs].sort()) {
      add(command(`app:${spec}`, `npm run verify -- app ${spec}`, { budgetSeconds: 30, why: "the changed spec", needs: { display: true } }));
    }
  }

  const order = ["change:", "docs-build", "check", "app", "app:", "app-mobile", "app-dogfood", "live-", "eval-core"];
  const rank = (id) => order.findIndex((prefix) => id === prefix || id.startsWith(prefix));
  const ordered = [...steps.values()].sort((a, b) => rank(a.id) - rank(b.id));

  const proposals = [];
  if (srcCount >= BIG_CHANGE_SRC_FILES) {
    proposals.push(
      `This is a big change (${srcCount} src/ files). Propose a chaos explore run to the owner: npm run verify -- explore --mode generic --max-steps 6`,
    );
  }
  return { files, steps: ordered, proposals, explain };
}

function formatPlan(plan, base) {
  const lines = [`verify plan: ${plan.files.length} changed file(s) since ${base}`];
  if (plan.files.length === 0) lines.push("  (no changes; `check` is still the gate before a PR)");
  lines.push("", "Run, in order:");
  plan.steps.forEach((step, index) => {
    const tags = [
      step.live ? "LIVE: local, needs a key" : null,
      step.needs?.display ? "needs a display" : null,
    ].filter(Boolean);
    lines.push(`  ${index + 1}. ${step.command}`);
    lines.push(`     ~${step.budgetSeconds}s; ${step.why}${tags.length > 0 ? ` [${tags.join("; ")}]` : ""}`);
  });
  if (plan.steps.some((step) => step.needs?.display)) {
    lines.push("", "No display? Run `npm run verify -- check --no-app` here and let CI run the app job.");
  }
  for (const proposal of plan.proposals) lines.push("", proposal);
  lines.push("", "Why: npm run verify -- plan --explain <path>");
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = { base: undefined, json: false, explain: undefined, run: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") options.base = argv[++index];
    else if (arg === "--json") options.json = true;
    else if (arg === "--explain") options.explain = argv[++index];
    else if (arg === "--run") options.run = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg !== "--") throw new Error(`unknown option ${arg}`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`verify plan: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(
      "Usage: npm run verify -- plan [--base <ref>] [--json] [--explain <path>] [--run]\n\n" +
        "Reads the diff since <ref> (default origin/main) plus uncommitted files, and prints\n" +
        "the commands it needs. --run executes the deterministic ones (never a LIVE step).",
    );
    return;
  }
  const cwd = process.cwd();
  const manifest = loadManifest(cwd);
  const testFiles = listTestFiles(manifest, cwd);
  const base = options.base ?? defaultBase(cwd);

  if (options.explain) {
    const plan = planFor([options.explain], manifest, testFiles);
    const entry = plan.explain[0];
    console.log(`${entry.file}:`);
    for (const reason of entry.reasons.length > 0 ? entry.reasons : ["matches no group and no trigger"]) console.log(`  - ${reason}`);
    console.log("Commands:");
    for (const step of plan.steps) console.log(`  ${step.command}`);
    return;
  }

  const exists = (file) => existsSync(path.join(cwd, file));
  const plan = planFor(changedFiles(base, cwd), manifest, testFiles, exists);
  if (options.json) {
    console.log(JSON.stringify({ base, ...plan }, null, 2));
    return;
  }
  process.stdout.write(formatPlan(plan, base));
  if (!options.run) return;

  for (const step of plan.steps.filter((entry) => !entry.live)) {
    console.log(`\n[plan] ${step.command}`);
    const [cmd, ...args] = step.command.split(" ");
    const result = spawnSync(cmd, args, { stdio: "inherit", cwd });
    if (result.status !== 0) {
      console.error(`[plan] stopped: ${step.command} exited ${result.status}`);
      process.exitCode = result.status ?? 1;
      return;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
