#!/usr/bin/env node
// Run the TypeScript 7 compiler.
//
// `typescript` stays on 5.x so typescript-eslint keeps the JS compiler API
// that TS 7.0 does not ship (upstream typescript-eslint#10940). This wrapper
// points every typecheck at the TS 7 binary without leaking a node_modules
// path into package.json or the verify lanes.
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(root, "node_modules", "typescript-7", "bin", "tsc");
const result = spawnSync(process.execPath, [tsc, ...process.argv.slice(2)], { stdio: "inherit" });

if (result.error) {
  console.error(`tsc7: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
