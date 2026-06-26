#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const defaultSpec = "test/e2e/specs/mobile-viewport.e2e.ts";
const args = process.argv.slice(2);
const hasSpec = args.some((arg) => arg === "--spec" || arg.startsWith("--spec="));
const runnerArgs = ["--import", "tsx", "scripts/run-e2e.ts", ...(hasSpec ? args : ["--spec", defaultSpec, ...args])];

const child = spawn(process.execPath, runnerArgs, {
  env: {
    ...process.env,
    AGENTIC_CHAT_E2E_MOBILE_VIEWPORT: "1",
    AGENTIC_CHAT_E2E_VIEWPORT_WIDTH: process.env.AGENTIC_CHAT_E2E_VIEWPORT_WIDTH ?? "390",
    AGENTIC_CHAT_E2E_VIEWPORT_HEIGHT: process.env.AGENTIC_CHAT_E2E_VIEWPORT_HEIGHT ?? "844",
  },
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
