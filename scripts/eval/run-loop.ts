/**
 * The eval run loop, without WebDriver (#392 item 5). A dead harness (the
 * WebDriver session or the Obsidian window is gone) stops the loop at once: the
 * remaining planned runs are written as `harness died: <message>` errors and no
 * more model calls happen. Before this, each remaining run became its own
 * harness error and the loop went on for minutes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { PlannedRun, RunRecord } from "./tool-use-plan";
import { emptyObservation } from "./tool-use-plan";

const DEAD_HARNESS = [
  /invalid session id/i,
  /session deleted/i,
  /no such window/i,
  /target window already closed/i,
  /chrome not reachable/i,
  /disconnected: not connected to devtools/i,
];

/** The message when an error means the harness is gone, else undefined. */
export function deadHarnessMessage(error: string | undefined): string | undefined {
  if (!error) return undefined;
  return DEAD_HARNESS.some((pattern) => pattern.test(error)) ? error.split("\n")[0].trim() : undefined;
}

export class HarnessDiedError extends Error {
  constructor(readonly reason: string, readonly remaining: number) {
    super(`harness died: ${reason} (${remaining} remaining run(s) recorded as errors, no more model calls)`);
    this.name = "HarnessDiedError";
  }
}

export function harnessDiedRecord(planned: PlannedRun, reason: string): RunRecord {
  return {
    caseId: planned.caseId,
    run: planned.run,
    ms: 0,
    usage: {},
    modelCalls: 0,
    observed: emptyObservation(),
    error: `harness died: ${reason}`,
  };
}

/**
 * Run every planned run through `execute` and `write` each record. A thrown
 * error or a record error that means a dead harness stops the loop; the rest
 * are written as `harness died` and the loop throws `HarnessDiedError`.
 */
export async function driveRuns(
  runs: readonly PlannedRun[],
  execute: (planned: PlannedRun) => Promise<RunRecord>,
  write: (record: RunRecord) => void,
): Promise<void> {
  for (let index = 0; index < runs.length; index += 1) {
    let reason: string | undefined;
    try {
      // Runs are sequential by design: one Obsidian, one vault, fixed driver ports.
      const record = await execute(runs[index]); // NOSONAR:S9382 -- one run at a time is the contract.
      write(record);
      reason = deadHarnessMessage(record.error);
    } catch (error_) {
      const message = error_ instanceof Error ? error_.message : String(error_);
      reason = deadHarnessMessage(message);
      if (!reason) throw error_;
      write(harnessDiedRecord(runs[index], reason));
    }
    if (reason) {
      const rest = runs.slice(index + 1);
      for (const planned of rest) write(harnessDiedRecord(planned, reason));
      throw new HarnessDiedError(reason, rest.length);
    }
  }
}

/**
 * Wrap a long command in `systemd-inhibit` so a laptop sleep cannot kill the
 * Obsidian session. Without the binary the command runs as it is.
 */
export function inhibitSleep(
  command: string,
  args: readonly string[],
  why: string,
  hasBinary: () => boolean = systemdInhibitExists,
): [string, string[]] {
  if (!hasBinary()) return [command, [...args]];
  return ["systemd-inhibit", ["--what=sleep:idle", `--why=${why}`, command, ...args]];
}

function systemdInhibitExists(): boolean {
  if (process.platform !== "linux") return false;
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir && existsSync(path.join(dir, "systemd-inhibit")));
}

/**
 * Hold a sleep inhibitor for the life of this process: `systemd-inhibit ... cat`
 * reads our stdin, so it exits when we end it or when we die. Returns a release
 * function; a no-op without the binary.
 */
export function holdSleepInhibit(why: string, hasBinary: () => boolean = systemdInhibitExists): () => void {
  if (!hasBinary()) return () => undefined;
  let holder: ChildProcess | undefined;
  try {
    holder = spawn("systemd-inhibit", ["--what=sleep:idle", `--why=${why}`, "cat"], { stdio: ["pipe", "ignore", "ignore"] }); // NOSONAR:S4036 -- systemd-inhibit and cat are fixed system tools, found on PATH like git in the other scripts.
    holder.on("error", () => undefined);
    holder.unref();
  } catch {
    return () => undefined;
  }
  return () => holder?.stdin?.end();
}
