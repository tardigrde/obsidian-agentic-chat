#!/usr/bin/env node
/* eslint-disable no-console -- CLI checker prints its findings. */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { compareStrings, listFiles, matchesAny } from "./lib/glob.mjs";
import { LANE_NAMES, RETIRED_LANES } from "./verify-lanes.mjs";

/**
 * Every `npm run <script>` in the docs, skills, and templates must name a
 * script in package.json, and every `npm run verify -- <lane>` a live lane.
 * A doc that teaches a deleted command costs the next agent a failed run.
 */

export const DOC_GLOBS = [
  "AGENTS.md",
  "README.md",
  "ROADMAP.md",
  "docs/**/*.md",
  ".agents/**/*.md",
  ".github/**/*.md",
];

/** History, not instructions: archives keep the commands of their day. */
export const IGNORED_DOCS = [
  "docs/development/roadmap-archive-*.md",
  "docs/development/feature-cut-2026-11.md",
  "CHANGELOG.md",
];

/**
 * Subcommands and flags that were removed, with what replaces each. A doc that
 * still teaches one costs the next agent a failed run (#393 T23, T26).
 */
export const RETIRED_ARGS = [
  {
    pattern: /\bnpm run delegate -- (work|ship|recheck|update)\b/,
    hint: "delegate keeps only `review` and `research`; the lead agent implements and fixes",
  },
  {
    pattern: /\bnpm run verify -- explore\b[^`\n]*--mode (focused|generic)\b/,
    hint: "explore has `--mode explore --live` and the dry `--mode smoke`",
  },
];

const NPM_RUN = /\bnpm run ([A-Za-z0-9:_.-]+)([ \t]+(?:--[ \t]+)?([^\s`'"|;&)]+))?/g;

export function findCommands(text) {
  const found = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(NPM_RUN)) {
      const script = match[1].replace(/[.:]+$/, "");
      found.push({ line: index + 1, script, lane: match[2]?.includes("--") || script === "verify" ? match[3] : undefined });
    }
  });
  return found;
}

export function checkDoc(file, text, scripts) {
  const errors = [];
  text.split("\n").forEach((line, index) => {
    for (const retired of RETIRED_ARGS) {
      const match = line.match(retired.pattern);
      if (match) errors.push(`${file}:${index + 1} names the removed \`${match[0]}\`; ${retired.hint}`);
    }
  });
  for (const command of findCommands(text)) {
    if (!Object.hasOwn(scripts, command.script)) {
      errors.push(`${file}:${command.line} names \`npm run ${command.script}\`, which package.json does not define`);
      continue;
    }
    if (command.script !== "verify" || !command.lane) continue;
    const lane = command.lane;
    if (lane.startsWith("-") || lane.startsWith("<") || lane.startsWith("$")) continue;
    if (Object.hasOwn(RETIRED_LANES, lane)) {
      errors.push(`${file}:${command.line} names the retired lane \`verify -- ${lane}\`; use \`verify -- ${RETIRED_LANES[lane]}\``);
    } else if (!LANE_NAMES.includes(lane)) {
      errors.push(`${file}:${command.line} names an unknown lane \`verify -- ${lane}\` (lanes: ${LANE_NAMES.join(", ")})`);
    }
  }
  return errors;
}

export function listDocs(root = process.cwd()) {
  const all = [...listFiles(root, ""), ...listFiles(root, ".agents"), ...listFiles(root, ".github")];
  return [...new Set(all)].filter((file) => matchesAny(file, DOC_GLOBS) && !matchesAny(file, IGNORED_DOCS)).sort(compareStrings);
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: node scripts/check-doc-commands.mjs\n\n" +
        "Every `npm run <script>` in AGENTS.md, README.md, docs/, .agents/, and .github/ must exist,\n" +
        "and every `npm run verify -- <lane>` must name a live lane.",
    );
    return;
  }
  const root = process.cwd();
  const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
  const docs = listDocs(root);
  const errors = docs.flatMap((file) => checkDoc(file, readFileSync(path.join(root, file), "utf8"), scripts));
  if (errors.length > 0) {
    console.error(`doc commands: FAIL (${errors.length} error(s))`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`doc commands: PASS (${docs.length} docs)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
