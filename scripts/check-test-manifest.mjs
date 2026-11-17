#!/usr/bin/env node
/* eslint-disable no-console -- CLI checker prints its findings. */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { listFiles, matchesAny } from "./lib/glob.mjs";

/**
 * Every test file belongs to exactly one group in test/manifest.json, and every
 * group says its tier, what triggers it, what it needs, and how to run it.
 * An unlisted test cannot be planned, so it fails `verify -- check`.
 */

export const MANIFEST_PATH = "test/manifest.json";
const TIERS = new Set(["T1", "T2", "T3", "T4"]);
const RUNNERS = new Set(["vitest", "wdio", "eval"]);
const REQUIRED = ["id", "tier", "runner", "globs", "triggers", "needs", "budgetSeconds", "command", "why"];

export function loadManifest(root = process.cwd()) {
  return JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), "utf8"));
}

export function groupMatches(group, file) {
  return matchesAny(file, group.globs) && !matchesAny(file, group.exclude ?? []);
}

/** The group a file belongs to, or undefined when it has none or several. */
export function groupFor(manifest, file) {
  const matches = manifest.groups.filter((group) => groupMatches(group, file));
  return matches.length === 1 ? matches[0] : undefined;
}

export function listTestFiles(manifest, root = process.cwd()) {
  return listFiles(root, "test").filter((file) => matchesAny(file, manifest.testFilePatterns));
}

export function checkManifest(manifest, files) {
  const errors = [];
  const ids = new Set();
  for (const group of manifest.groups ?? []) {
    for (const key of REQUIRED) {
      if (group[key] === undefined) errors.push(`group ${group.id ?? "(no id)"} has no "${key}"`);
    }
    if (ids.has(group.id)) errors.push(`group id "${group.id}" is used twice`);
    ids.add(group.id);
    if (!TIERS.has(group.tier)) errors.push(`group ${group.id}: tier must be one of ${[...TIERS].join(", ")}`);
    if (!RUNNERS.has(group.runner)) errors.push(`group ${group.id}: runner must be one of ${[...RUNNERS].join(", ")}`);
    if (!Array.isArray(group.globs) || group.globs.length === 0) errors.push(`group ${group.id}: globs is empty`);
  }

  const counts = new Map((manifest.groups ?? []).map((group) => [group.id, 0]));
  for (const file of files) {
    const matches = manifest.groups.filter((group) => groupMatches(group, file));
    if (matches.length === 0) {
      errors.push(`${file} is in no group; add it to a group's globs in ${MANIFEST_PATH}`);
    } else if (matches.length > 1) {
      errors.push(`${file} is in ${matches.length} groups (${matches.map((group) => group.id).join(", ")}); keep one`);
    } else {
      counts.set(matches[0].id, (counts.get(matches[0].id) ?? 0) + 1);
    }
  }
  for (const [id, count] of counts) {
    if (count === 0) errors.push(`group ${id} matches no test file; delete it or fix its globs`);
  }
  return { errors, counts };
}

function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/check-test-manifest.mjs [--list]\n\nEvery test file must match exactly one group in test/manifest.json.");
    return;
  }
  const manifest = loadManifest();
  const files = listTestFiles(manifest);
  const { errors, counts } = checkManifest(manifest, files);
  if (process.argv.includes("--list")) {
    for (const group of manifest.groups) console.log(`${group.tier}  ${group.id.padEnd(22)} ${counts.get(group.id)} file(s)`);
  }
  if (errors.length > 0) {
    console.error(`test manifest: FAIL (${errors.length} error(s))`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`test manifest: PASS (${files.length} test files in ${manifest.groups.length} groups)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
