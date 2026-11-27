#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the cycle gate result. */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import madge from "madge";

/**
 * The layering gate (#438). `madge` walks `src/` and reports every circular
 * import. The allowlist is empty on purpose: the 14 cycles in the issue were
 * removed by depending on neutral types and small secret-id helpers instead of
 * reaching back into the modules that use them. A new cycle fails `check`.
 */
export const SOURCE_DIR = "src";
export const ALLOWLIST = [];

/** One cycle as the stable text used by the allowlist and the failure output. */
export function cycleText(cycle) {
  return cycle.join(" > ");
}

/** Cycles not covered by the allowlist. */
export function unexpectedCycles(cycles, allowlist = ALLOWLIST) {
  const allowed = new Set(allowlist.map(cycleText));
  return cycles.filter((cycle) => !allowed.has(cycleText(cycle)));
}

/** Allowlist entries that no longer match a cycle; they hide a fixed cycle. */
export function staleAllowlist(cycles, allowlist = ALLOWLIST) {
  const found = new Set(cycles.map(cycleText));
  return allowlist.filter((cycle) => !found.has(cycleText(cycle)));
}

/** Run madge over `<root>/src` using the repo tsconfig when it exists. */
export async function findCycles(root = process.cwd()) {
  const tsConfig = path.join(root, "tsconfig.json");
  const result = await madge(path.join(root, SOURCE_DIR), {
    fileExtensions: ["ts"],
    ...(existsSync(tsConfig) ? { tsConfig } : {}),
  });
  return result.circular();
}

async function main() {
  const root = process.cwd();
  let cycles;
  try {
    cycles = await findCycles(root);
  } catch (error) {
    console.error(`cycles: madge failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const unexpected = unexpectedCycles(cycles);
  const stale = staleAllowlist(cycles);
  if (unexpected.length > 0 || stale.length > 0) {
    console.error(
      `cycles: FAIL (${unexpected.length} new cycle(s), ${stale.length} stale allowlist entry/entries)`,
    );
    for (const cycle of unexpected) console.error(`  - ${SOURCE_DIR}/${cycleText(cycle)}`);
    for (const entry of stale) console.error(`  - allowlist entry no longer found: ${entry}`);
    process.exitCode = 1;
    return;
  }
  console.log(`cycles: PASS (${cycles.length} allowed, 0 unexpected in ${SOURCE_DIR}/)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
