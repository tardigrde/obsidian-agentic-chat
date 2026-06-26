#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const defaultMatrix = "earliest/earliest,latest/latest";
const matrix = (process.env.OBSIDIAN_VERSION_MATRIX || defaultMatrix)
  .split(/[,\s]+/)
  .map((entry) => entry.trim())
  .filter(Boolean);

if (matrix.length === 0) {
  console.error("OBSIDIAN_VERSION_MATRIX did not contain any version entries.");
  process.exit(1);
}

const passthroughArgs = process.argv.slice(2);

for (const versionSpec of matrix) {
  console.warn(`\n[e2e:matrix] Obsidian ${versionSpec}`);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/run-e2e.ts", ...passthroughArgs],
    {
      env: {
        ...process.env,
        OBSIDIAN_VERSIONS: versionSpec,
      },
      stdio: "inherit",
    },
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.warn("\n[e2e:matrix] all configured Obsidian versions passed");
