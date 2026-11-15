#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints usage and the display it picked. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

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

/**
 * Start Xephyr and let it choose the display with `-displayfd 3`, so two
 * wrappers cannot both pick the same number. With `--display`, only check that
 * the server is already there; the caller owns its lifetime.
 */
function startXephyr(args) {
  return new Promise((resolve, reject) => {
    if (args.display !== undefined) {
      if (!existsSync(displaySocket(args.display))) {
        reject(new Error(`No X server on :${args.display}. Start Xephyr first or drop --display.`));
        return;
      }
      resolve({ child: undefined, display: args.display });
      return;
    }

    const child = spawn( // NOSONAR:S4036 -- Xephyr is a fixed developer binary resolved from PATH; this is local tooling, not a privileged service.
      "Xephyr",
      ["-displayfd", "3", "-screen", args.screen, "-ac", "-noreset", "-title", args.title],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    let settled = false;
    let buffer = "";
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    child.once("error", (error) => {
      if (error && error.code === "ENOENT") {
        finish(
          reject,
          new Error("Xephyr is not on PATH. Install xserver-xephyr, or use `xvfb-run -a` for an invisible run."),
        );
        return;
      }
      finish(reject, error);
    });
    child.once("exit", (code, signal) => {
      finish(reject, new Error(`Xephyr exited before choosing a display (${code ?? signal}).`));
    });
    child.stdio[3]?.on("data", (data) => {
      buffer += data.toString();
      const line = buffer.split("\n")[0]?.trim();
      if (!line) return;
      const display = Number(line);
      if (!Number.isInteger(display) || display < 1) {
        finish(reject, new Error(`Xephyr wrote an invalid display number: ${JSON.stringify(line)}`));
        return;
      }
      finish(resolve, { child, display });
    });
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
    "Without --display, Xephyr picks a free display and the wrapper stops it when",
    "the command exits. With --display, the wrapper reuses that server and leaves",
    "its lifetime to you.",
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

  const { child: xephyr, display } = await startXephyr(args);
  console.log(
    xephyr
      ? `[nested] Xephyr :${display} (${args.screen}); the host display keeps focus.`
      : `[nested] reusing display :${display}.`,
  );

  let commandChild;
  const stopXephyr = () => {
    if (xephyr && !xephyr.killed) xephyr.kill("SIGTERM");
  };
  const onSignal = (signal) => {
    commandChild?.kill(signal);
    stopXephyr();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("exit", stopXephyr);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const [command, ...commandArgs] = args.command;
    commandChild = spawn(command, commandArgs, {
      stdio: "inherit",
      env: { ...process.env, DISPLAY: `:${display}` },
    });
    const code = await new Promise((resolve) => {
      commandChild.on("error", (error) => {
        console.error(`[nested] could not start ${command}: ${error.message}`);
        resolve(1);
      });
      commandChild.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    });
    process.exitCode = code;
  } finally {
    stopXephyr();
    process.removeListener("exit", stopXephyr);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    console.error(`[nested] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
