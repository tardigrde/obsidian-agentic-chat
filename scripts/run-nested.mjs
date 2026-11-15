#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints usage and the display it picked. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

/**
 * Run a headed Obsidian command on a nested Xephyr display.
 *
 * The e2e, eval, and dogfood lanes open real Electron windows. On a desktop
 * session, every new window asks the window manager to activate it, which steals
 * the cursor from the user. Xephyr is a second X server in a normal window: the
 * app is still a real GUI (not `--ozone-platform=headless`), but its windows
 * never touch the host display's focus.
 *
 *   npm run nested -- npm run verify -- e2e test/e2e/specs/smoke.e2e.ts
 *   npm run nested -- npm run eval:tool-use -- --suite ... --runs 3 --env-file .env
 *
 * `--display :1` reuses an Xephyr that is already running. `--screen WxH`
 * changes the nested screen size (default 1440x1000).
 */

const DEFAULT_SCREEN = "1440x1000";
const DEFAULT_TITLE = "agentic-chat e2e";
const FIRST_DISPLAY = 101;
const LAST_DISPLAY = 199;

export function displaySocket(displayNumber) {
  return `/tmp/.X11-unix/X${displayNumber}`;
}

/** Pure parser, so the CLI shape is testable without an X server. */
export function parseArgs(argv) {
  const args = {
    screen: DEFAULT_SCREEN,
    title: DEFAULT_TITLE,
    display: undefined,
    command: [],
    help: false,
  };
  const rest = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--") {
      args.command = rest.slice(index + 1);
      break;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--screen" || arg === "--title" || arg === "--display") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--screen") args.screen = value;
      if (arg === "--title") args.title = value;
      if (arg === "--display") args.display = normalizeDisplay(value);
      index += 1;
      continue;
    }
    args.command = rest.slice(index);
    break;
  }
  return args;
}

/** Accept ":1" or "1" and return 1. */
export function normalizeDisplay(value) {
  const match = /^:?(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`--display must look like :1 or 1, got ${value}`);
  return Number(match[1]);
}

/** First display whose socket does not exist, so parallel runs do not collide. */
export function pickDisplay(isTaken = (number) => existsSync(displaySocket(number))) {
  for (let number = FIRST_DISPLAY; number <= LAST_DISPLAY; number += 1) {
    if (!isTaken(number)) return number;
  }
  throw new Error(`No free X display in :${FIRST_DISPLAY}-:${LAST_DISPLAY}.`);
}

async function waitForDisplay(number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(displaySocket(number))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Xephyr did not create ${displaySocket(number)} within ${timeoutMs} ms.`);
}

function startXephyr(number, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "Xephyr",
      [`:${number}`, "-screen", args.screen, "-ac", "-noreset", "-title", args.title],
      { stdio: "ignore" },
    );
    child.once("error", (error) => {
      if (error && error.code === "ENOENT") {
        reject(new Error("Xephyr is not on PATH. Install xserver-xephyr, or use `xvfb-run -a` for an invisible run."));
        return;
      }
      reject(error);
    });
    child.once("spawn", () => resolve(child));
  });
}

function usage() {
  return [
    "Usage: npm run nested -- [--screen WxH] [--title text] [--display :N] -- <command...>",
    "",
    "Examples:",
    "  npm run nested -- npm run verify -- e2e test/e2e/specs/smoke.e2e.ts",
    "  npm run nested -- npm run eval:tool-use -- --suite test/evals/tool-use/core.eval.json --runs 3 --env-file .env",
    "  npm run nested -- --screen 390x844 -- npm run verify -- e2e test/e2e/specs/mobile-viewport.e2e.ts",
    "",
    "Without --display, the script starts Xephyr on a free display and stops it",
    "when the command exits. With --display, it uses that display and leaves the",
    "Xephyr process alone.",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command.length === 0) {
    console.log(usage());
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  if (process.platform !== "linux") {
    throw new Error("The nested display helper is Linux-only. Use the CI xvfb-run lane on other platforms.");
  }

  const ownsDisplay = args.display === undefined;
  const number = args.display ?? pickDisplay();
  let xephyr;
  if (ownsDisplay) {
    xephyr = await startXephyr(number, args);
    await waitForDisplay(number);
    console.log(`[nested] Xephyr :${number} (${args.screen}); the host display keeps focus.`);
  } else {
    console.log(`[nested] reusing display :${number}.`);
  }

  const stopXephyr = () => {
    if (xephyr && !xephyr.killed) xephyr.kill("SIGTERM");
  };
  process.on("exit", stopXephyr);

  try {
    const [command, ...commandArgs] = args.command;
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      env: { ...process.env, DISPLAY: `:${number}` },
    });
    const code = await new Promise((resolve) => {
      child.on("error", (error) => {
        console.error(`[nested] could not start ${command}: ${error.message}`);
        resolve(1);
      });
      child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    });
    process.exitCode = code;
  } finally {
    stopXephyr();
    process.removeListener("exit", stopXephyr);
  }
}

void main().catch((error) => {
  console.error(`[nested] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
