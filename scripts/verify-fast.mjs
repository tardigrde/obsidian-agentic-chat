#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const smokeSpec = "test/e2e/specs/smoke.e2e.ts";
const nodeCommand = process.execPath;

const steps = [
  { label: "typecheck", command: localBin("tsc"), args: ["-noEmit"] },
  { label: "e2e typecheck", command: localBin("tsc"), args: ["-p", "tsconfig.e2e.json", "--noEmit"] },
  { label: "lint", command: localBin("eslint"), args: ["."] },
  { label: "lint:obsidian", command: localBin("eslint"), args: ["-c", "eslint.config.obsidian.mjs", "src"] },
  { label: "unit tests", command: localBin("vitest"), args: ["run"] },
  { label: "e2e bundle", command: nodeCommand, args: ["esbuild.config.mjs", "production"] },
  { label: "release verification", command: nodeCommand, args: ["scripts/verify-release.mjs"] },
  { label: "mobile compatibility", command: nodeCommand, args: ["scripts/verify-mobile-compat.mjs"] },
  {
    label: "smoke e2e",
    command: nodeCommand,
    args: ["--import", "tsx", "scripts/run-e2e.ts", "--spec", smokeSpec],
    explainE2eSandboxFailure: true,
  },
];

export function isTsxIpcSandboxFailure(output) {
  return /listen EPERM: operation not permitted .*tsx-\d+\/.+\.pipe/s.test(output);
}

export function isChromedriverSandboxFailure(output) {
  return /CreatePlatformSocket\(\) failed: Operation not permitted|Could not start chromedriver/s.test(output);
}

async function main() {
  for (const step of steps) {
    console.warn(`\n[verify:fast] ${step.label}`);
    const result = await runStep(step.command, step.args);
    if (result.code === 0) continue;

    console.error(`\n[verify:fast] ${step.label} failed with exit code ${result.code}.`);
    if (step.explainE2eSandboxFailure && isKnownNestedE2eSandboxFailure(result.output)) {
      printNestedE2eSandboxHint(result.output);
    } else {
      printOutputTail(result.output);
    }
    return result.code;
  }

  console.warn("\n[verify:fast] all checks passed");
  return 0;
}

function localBin(name) {
  return path.resolve("node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function runStep(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: childEnv(),
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      output += message;
      console.error(message);
      resolve({ code: 1, output });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key === "INIT_CWD") delete env[key];
  }
  return env;
}

function isKnownNestedE2eSandboxFailure(output) {
  return output.trim() === "" || isTsxIpcSandboxFailure(output) || isChromedriverSandboxFailure(output);
}

function printNestedE2eSandboxHint(output) {
  printOutputTail(output);
  console.error(`
[verify:fast] The core checks passed, but the smoke e2e runner did not start.
[verify:fast] In sandboxed shells this can happen when nested e2e needs local IPC/listen sockets.
[verify:fast] Rerun the smoke e2e as a top-level command:
[verify:fast]   rtk npm run test:e2e -- --spec ${smokeSpec}
`);
}

function printOutputTail(output) {
  const lines = output.trim().split(/\r?\n/).slice(-80);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return;
  console.error("\n[verify:fast] last child output:");
  console.error(lines.join("\n"));
}

const exitCode = await main();
process.exitCode = exitCode;
