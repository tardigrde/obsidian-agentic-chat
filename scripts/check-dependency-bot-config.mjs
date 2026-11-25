#!/usr/bin/env node
/* eslint-disable no-console -- CLI checker prints its findings. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * One dependency bot, and the two groups that must never split.
 *
 * Renovate and Dependabot opened PRs for the same packages (#411-#415 and
 * #421-#428), so the repo keeps Renovate only. The groups carry the breakages
 * that made them necessary: `@vitest/coverage-v8` peers an exact vitest
 * version (#163/#165), and `pi-agent-core` nests its own pi-ai copy, so a lone
 * bump splits the `AssistantMessageEventStream` class (#154/#156).
 */

export const DEPENDABOT_CONFIG = ".github/dependabot.yml";
export const RENOVATE_CONFIG = "renovate.json";

/** A group name and the package patterns its rule must keep together. */
export const REQUIRED_GROUPS = [
  { groupName: "vitest", packages: ["vitest", "@vitest/**"] },
  { groupName: "earendil-works", packages: ["@earendil-works/**"] },
];

/**
 * @param {{ renovate: string | null, dependabot: boolean }} input
 *   `renovate` is the config text, or null when the file is absent;
 *   `dependabot` is true when the Dependabot config still exists.
 * @returns {string[]} what to fix, empty when the repo has one configured bot.
 */
export function checkDependencyBotConfig({ renovate, dependabot }) {
  const errors = [];
  if (dependabot) {
    errors.push(`${DEPENDABOT_CONFIG} exists: Renovate owns the updates, so delete the Dependabot config`);
  }
  if (renovate === null) {
    errors.push(`${RENOVATE_CONFIG} is missing`);
    return errors;
  }
  let config;
  try {
    config = JSON.parse(renovate);
  } catch (error) {
    errors.push(`${RENOVATE_CONFIG} is not valid JSON: ${error.message}`);
    return errors;
  }
  const rules = Array.isArray(config.packageRules) ? config.packageRules : [];
  for (const group of REQUIRED_GROUPS) {
    const rule = rules.find((entry) => entry?.groupName === group.groupName);
    const patterns = Array.isArray(rule?.matchPackageNames) ? rule.matchPackageNames : [];
    for (const pkg of group.packages) {
      if (!patterns.includes(pkg)) {
        errors.push(`${RENOVATE_CONFIG}: group "${group.groupName}" must match "${pkg}"`);
      }
    }
  }
  return errors;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: node scripts/check-dependency-bot-config.mjs\n\n" +
        "Fails when Dependabot and Renovate are both configured, or when renovate.json loses a required package group.",
    );
    return;
  }
  const root = process.cwd();
  const renovatePath = path.join(root, RENOVATE_CONFIG);
  const errors = checkDependencyBotConfig({
    renovate: existsSync(renovatePath) ? readFileSync(renovatePath, "utf8") : null,
    dependabot: existsSync(path.join(root, DEPENDABOT_CONFIG)),
  });
  if (errors.length > 0) {
    console.error(`dependency bot config: FAIL (${errors.length} error(s))`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`dependency bot config: PASS (Renovate only, ${REQUIRED_GROUPS.length} groups)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
