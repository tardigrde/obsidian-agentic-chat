#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * Shared plumbing for the probe and chaos-monkey runners: CLI parsing, Xvfb,
 * ffmpeg capture, and the artifact helpers. Keeping it here prevents the two
 * live harnesses from drifting apart.
 */

export type TimelineEntry = { t: number; label: string };

export type RunOptions = {
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  quiet?: boolean;
};

export const BINARY_DIRS = ["/usr/bin", "/usr/local/bin", "/bin"];

export function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next && !next.startsWith("--") ? next : "";
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
}

export function parseSize(
  value: string | undefined,
  fail: (message: string) => never,
): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  if (!match) fail(`--size must look like 1440x1000, got ${value ?? "(missing)"}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Load .env without importing ESM from a CJS-emitted script. Existing env wins. */
export function applyEnvFile(file: string): void {
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();

    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^\w+$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unwrapEnvValue(line.slice(equals + 1));
  }
}

export function unwrapEnvValue(raw: string): string {
  const value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Resolve a binary from fixed, unwriteable directories instead of trusting PATH.
 * Set FFMPEG_PATH or XVFB_PATH to override.
 */
export function resolveBinary(name: string, override: string | undefined): string | undefined {
  const explicit = override?.trim();
  if (explicit) return explicit;
  for (const dir of BINARY_DIRS) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function requireBinary(
  name: string,
  resolved: string | undefined,
  hint: string,
  fail: (message: string) => never,
): string {
  if (!resolved) fail(`${name} is not installed. ${hint}`);
  return resolved;
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      stdio: options.quiet ? ["ignore", "ignore", "ignore"] : "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const exit = code ?? 1; // NOSONAR:S7760 -- close passes null on signal termination; a default parameter only catches undefined.
      if (exit !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} exited ${exit}`));
        return;
      }
      resolve(exit);
    });
  });
}

export function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, 100);
  });
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function pickDisplay(fail: (message: string) => never): number {
  for (let candidate = 99; candidate <= 120; candidate += 1) {
    if (!existsSync(`/tmp/.X11-unix/X${candidate}`)) return candidate;
  }
  fail("no free X display between :99 and :120");
}

export async function startXvfb(
  binary: string,
  display: string,
  width: number,
  height: number,
): Promise<ChildProcess> {
  const child = spawn(binary, [display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-ac"], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const displayNumber = display.replace(":", "");
  await waitFor(
    () => existsSync(`/tmp/.X11-unix/X${displayNumber}`),
    8_000,
    `Xvfb did not start on ${display}. ${stderr.trim()}`,
  );
  return child;
}

/**
 * Start a nested X server (Xephyr) as one window on the user's desktop. The run
 * is visible to the user, and a recording of this display holds only that
 * window, never the rest of the real screen.
 */
export async function startXephyr(
  binary: string,
  display: string,
  width: number,
  height: number,
): Promise<ChildProcess> {
  const child = spawn(
    binary,
    [display, "-screen", `${width}x${height}`, "-ac", "-br", "-noreset", "-nolisten", "tcp", "-title", "Agentic Chat chaos"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const displayNumber = display.replace(":", "");
  await waitFor(
    () => existsSync(`/tmp/.X11-unix/X${displayNumber}`),
    8_000,
    `Xephyr did not start on ${display}. Is DISPLAY set to your desktop? ${stderr.trim()}`,
  );
  return child;
}

export async function startFfmpeg(
  binary: string,
  display: string,
  width: number,
  height: number,
  fps: number,
  file: string,
): Promise<ChildProcess> {
  const child = spawn(
    binary,
    [
      "-y",
      "-loglevel",
      "warning",
      "-f",
      "x11grab",
      "-framerate",
      String(fps),
      "-video_size",
      `${width}x${height}`,
      "-i",
      display,
      "-draw_mouse",
      "1",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      file,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  await new Promise((resolve) => setTimeout(resolve, 800));
  if (child.exitCode !== null) {
    throw new Error(`ffmpeg exited before recording started. ${stderr.trim()}`);
  }
  return child;
}

export async function stopProcess(child: ChildProcess | undefined, signal: NodeJS.Signals): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  if (await waitForExit(child, 8_000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2_000);
}

export async function readTimeline(outDir: string): Promise<TimelineEntry[]> {
  try {
    return JSON.parse(await readFile(path.join(outDir, "timeline.json"), "utf8")) as TimelineEntry[];
  } catch {
    return [];
  }
}

export async function extractFrames(
  binary: string,
  mp4: string,
  outDir: string,
  timeline: TimelineEntry[],
): Promise<string[]> {
  if (timeline.length === 0) return [];
  const shotsDir = path.join(outDir, "shots");
  await mkdir(shotsDir, { recursive: true });

  const files: string[] = [];
  for (const [index, entry] of timeline.entries()) {
    const name = `${String(index + 1).padStart(2, "0")}-${slug(entry.label)}.png`;
    const target = path.join(shotsDir, name);
    await run( // NOSONAR:S9382 -- run ffmpeg one frame at a time; parallel seeks contend for CPU.
      binary,
      ["-y", "-loglevel", "error", "-i", mp4, "-ss", String(entry.t), "-frames:v", "1", "-q:v", "2", target],
      { allowFailure: true, quiet: true },
    );
    if (existsSync(target)) files.push(path.join("shots", name));
  }
  return files;
}

/**
 * Obsidian takes several seconds to paint, so a full-display recording starts
 * with a black screen. Trim to just before the first mark and keep the raw file
 * for debugging. The timeline is rewritten so keyframes stay aligned.
 */
export async function trimLeadIn(
  binary: string,
  mp4: string,
  outDir: string,
  timeline: TimelineEntry[],
): Promise<{ timeline: TimelineEntry[]; trimMs: number }> {
  if (timeline.length === 0) return { timeline, trimMs: 0 };
  // Keep a quarter second of context before the first mark; anything earlier is
  // the black screen while Obsidian paints.
  const trim = Math.max(0, timeline[0].t - 0.25);
  if (trim < 0.1) return { timeline, trimMs: 0 };

  const trimmed = mp4.replace(/\.mp4$/, "-trimmed.mp4");
  await run(
    binary,
    [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      String(trim),
      "-i",
      mp4,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      trimmed,
    ],
    { allowFailure: true, quiet: true },
  );

  if (!existsSync(trimmed)) return { timeline, trimMs: 0 };

  const raw = mp4.replace(/\.mp4$/, "-raw.mp4");
  await rename(mp4, raw);
  await rename(trimmed, mp4);

  const adjusted = timeline.map((entry) => ({
    ...entry,
    t: Math.max(0, Number((entry.t - trim).toFixed(3))),
  }));
  await writeFile(path.join(outDir, "timeline.json"), `${JSON.stringify(adjusted, null, 2)}\n`);
  return { timeline: adjusted, trimMs: Math.round(trim * 1000) };
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
