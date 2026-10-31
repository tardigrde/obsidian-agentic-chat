#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type TimelineEntry = { t: number; label: string };

const SCENARIO_DIR = path.resolve("test/e2e/probe/scenarios");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next && !next.startsWith("--") ? next : "";
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function fail(message: string): never {
  console.error(`\n[probe] ${message}`);
  process.exit(1);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "probe";
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

function parseSize(value: string | undefined): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  if (!match) fail(`--size must look like 1440x1000, got ${value ?? "(missing)"}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseTime(value: string): number {
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  const parts = value.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) fail(`invalid time: ${value}`);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function which(binary: string): boolean {
  return spawnSync("which", [binary], { stdio: "ignore" }).status === 0;
}

/** Load .env without importing ESM from a CJS-emitted script. Existing env wins. */
function applyEnvFile(file: string): void {
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean; quiet?: boolean } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      stdio: options.quiet ? ["ignore", "ignore", "ignore"] : "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const exit = code ?? 1;
      if (exit !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} exited ${exit}`));
        return;
      }
      resolve(exit);
    });
  });
}

function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
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

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function pickDisplay(): number {
  for (let candidate = 99; candidate <= 120; candidate += 1) {
    if (!existsSync(`/tmp/.X11-unix/X${candidate}`)) return candidate;
  }
  fail("no free X display between :99 and :120");
}

async function listScenarios(): Promise<string[]> {
  const entries = await readdir(SCENARIO_DIR);
  return entries.filter((entry) => entry.endsWith(".e2e.ts")).map((entry) => entry.replace(/\.e2e\.ts$/, ""));
}

async function startXvfb(display: string, width: number, height: number): Promise<ChildProcess> {
  const child = spawn(
    "Xvfb",
    [display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-ac"],
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
    `Xvfb did not start on ${display}. ${stderr.trim()}`,
  );
  return child;
}

async function startFfmpeg(display: string, width: number, height: number, fps: number, file: string): Promise<ChildProcess> {
  const child = spawn(
    "ffmpeg",
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

async function stopProcess(child: ChildProcess | undefined, signal: NodeJS.Signals): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  if (await waitForExit(child, 8_000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2_000);
}

async function readTimeline(outDir: string): Promise<TimelineEntry[]> {
  try {
    return JSON.parse(await readFile(path.join(outDir, "timeline.json"), "utf8")) as TimelineEntry[];
  } catch {
    return [];
  }
}

async function extractFrames(mp4: string, outDir: string, timeline: TimelineEntry[]): Promise<string[]> {
  if (timeline.length === 0) return [];
  const shotsDir = path.join(outDir, "shots");
  await mkdir(shotsDir, { recursive: true });

  const files: string[] = [];
  for (const [index, entry] of timeline.entries()) {
    const name = `${String(index + 1).padStart(2, "0")}-${slug(entry.label)}.png`;
    const target = path.join(shotsDir, name);
    await run(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", mp4, "-ss", String(entry.t), "-frames:v", "1", "-q:v", "2", target],
      { allowFailure: true, quiet: true },
    );
    if (existsSync(target)) files.push(path.join("shots", name));
  }
  return files;
}

async function makeGif(mp4: string, outDir: string, range: string): Promise<string | undefined> {
  const [startRaw, endRaw] = range.split("-");
  const start = parseTime(startRaw || "0");
  const end = endRaw ? parseTime(endRaw) : start + 8;
  const duration = Math.max(0.5, end - start);
  const target = path.join(outDir, "key.gif");

  await run(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      String(start),
      "-t",
      String(duration),
      "-i",
      mp4,
      "-vf",
      "fps=10,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
      "-loop",
      "0",
      target,
    ],
    { allowFailure: true, quiet: true },
  );

  return existsSync(target) ? "key.gif" : undefined;
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

async function writeReport(input: {
  outDir: string;
  scenario: string;
  mode: "live" | "scripted";
  display: string;
  width: number;
  height: number;
  fps: number;
  code: number;
  failure?: string;
  startedAt: number;
  finishedAt: number;
  timeline: TimelineEntry[];
  frames: string[];
  gif?: string;
}): Promise<void> {
  const result = input.code === 0 ? "PASS" : "FAIL";
  const rows =
    input.timeline.length > 0
      ? input.timeline
          .map((entry) => `| ${entry.t.toFixed(2)}s | ${entry.label} |`)
          .join("\n")
      : "| - | no marks recorded |";

  let metrics = "{}";
  const metricsPath = path.join(input.outDir, "metrics.json");
  if (existsSync(metricsPath)) {
    try {
      metrics = await readFile(metricsPath, "utf8");
    } catch {
      metrics = "{}";
    }
  }

  const artifacts = [
    "- `session.mp4` (whole display)",
    input.gif ? `- \`${input.gif}\`` : undefined,
    input.frames.length > 0 ? `- \`shots/\` (${input.frames.length} keyframes)` : undefined,
    "- `timeline.json`",
    existsSync(metricsPath) ? "- `metrics.json`" : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  const failure = input.failure ? `\n- failure: ${input.failure}\n` : "";

  const report = `# Probe: ${path.basename(input.scenario, ".e2e.ts")}

- scenario: \`${input.scenario}\`
- mode: \`${input.mode}\`
- result: \`${result}\` (exit ${input.code})
- display: \`${input.display}\` ${input.width}x${input.height} @ ${input.fps}fps
- duration: ${formatDuration(input.finishedAt - input.startedAt)}
- started: ${new Date(input.startedAt).toISOString()}${failure}

## Timeline

| t | mark |
|---|---|
${rows}

## Artifacts

${artifacts}

## Metrics

\`\`\`json
${metrics.trim()}
\`\`\`

## Observations

<!-- Fill this in after watching the recording and reading the keyframes.

Hypothesis:
Observed:
Decision: keep | change | kill
Open questions:
-->
`;

  await writeFile(path.join(input.outDir, "report.md"), report);
}

async function main(): Promise<void> {
  if (has("--list")) {
    for (const scenario of await listScenarios()) process.stdout.write(`${scenario}\n`);
    return;
  }

  const scenarioArg = arg("--scenario");
  if (!scenarioArg) fail(`--scenario is required. Run: npm run probe -- --list`);

  const scenario = scenarioArg.includes("/") || scenarioArg.endsWith(".ts")
    ? path.resolve(scenarioArg)
    : path.join(SCENARIO_DIR, `${scenarioArg}.e2e.ts`);
  if (!existsSync(scenario)) fail(`scenario not found: ${scenario}`);

  const live = has("--live");
  const noBuild = has("--no-build");
  const keepDisplay = has("--keep-display");
  const size = parseSize(arg("--size") ?? "1440x1000");
  const fps = Number(arg("--fps") ?? "15");
  const displayOverride = arg("--display");

  if (!Number.isFinite(fps) || fps <= 0) fail(`--fps must be a positive number, got ${arg("--fps")}`);

  const envFile = path.resolve(".env");
  if (existsSync(envFile)) applyEnvFile(envFile);

  if (live) {
    const key = process.env.AGENTIC_CHAT_API_KEY?.trim();
    const keyFile = process.env.AGENTIC_CHAT_API_KEY_FILE?.trim();
    if (!key && !keyFile) {
      fail(
        "--live needs AGENTIC_CHAT_API_KEY or AGENTIC_CHAT_API_KEY_FILE. " +
          "Put it in .env (gitignored). A scripted run is not a substitute.",
      );
    }
  }

  if (!which("ffmpeg")) fail("ffmpeg is not installed. Install it: sudo apt install ffmpeg");
  if (!displayOverride && process.platform !== "linux") {
    fail("probes need Xvfb on Linux. Pass --display to record an existing display.");
  }
  if (!displayOverride && !which("Xvfb")) {
    fail("Xvfb is not installed. Install it: sudo apt install xvfb. Or pass --display :0 to record your desktop.");
  }

  const outDir = path.resolve(arg("--out") ?? path.join("logs", "probes", `${stamp()}-${path.basename(scenario, ".e2e.ts")}`));
  await mkdir(outDir, { recursive: true });

  const display = displayOverride || `:${pickDisplay()}`;
  const mp4 = path.join(outDir, "session.mp4");
  let xvfb: ChildProcess | undefined;
  let ffmpeg: ChildProcess | undefined;
  let code = 1;
  let failure: string | undefined;
  let recordingStartedAt: number | undefined;
  const startedAt = Date.now();

  process.stdout.write(`[probe] ${path.basename(scenario)}\n`);
  process.stdout.write(`[probe] mode: ${live ? "live" : "scripted"}\n`);
  process.stdout.write(`[probe] display: ${display} ${size.width}x${size.height}\n`);
  process.stdout.write(`[probe] output: ${outDir}\n`);

  try {
    if (!noBuild) {
      process.stdout.write(`[probe] building ${live ? "production" : "e2e"} bundle\n`);
      if (live) await run(process.execPath, ["esbuild.config.mjs", "production"]);
      else await run(process.execPath, ["scripts/build-e2e.mjs"]);
    }

    if (!displayOverride) {
      xvfb = await startXvfb(display, size.width, size.height);
    } else {
      process.stderr.write("[probe] recording an existing display; every window on it will be in frame.\n");
    }

    const recordingStart = Date.now();
    recordingStartedAt = recordingStart;
    ffmpeg = await startFfmpeg(display, size.width, size.height, fps, mp4);

    code = await run(
      process.execPath,
      ["--import", "tsx", "scripts/run-e2e.ts", "--spec", scenario],
      {
        allowFailure: true,
        env: {
          DISPLAY: display,
          AGENTIC_CHAT_PROBE: "1",
          AGENTIC_CHAT_PROBE_OUT: outDir,
          AGENTIC_CHAT_PROBE_LIVE: live ? "1" : "0",
          AGENTIC_CHAT_PROBE_STARTED_AT: String(recordingStart),
          AGENTIC_CHAT_E2E_WINDOW_SIZE: `${size.width}x${size.height}`,
          AGENTIC_CHAT_E2E_HEADLESS: "0",
          AGENTIC_CHAT_E2E_MOBILE_VIEWPORT: "0",
          WDIO_MAX_INSTANCES: "1",
        },
      },
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await stopProcess(ffmpeg, "SIGINT");
  }

  const finishedAt = Date.now();
  const timeline = await readTimeline(outDir);
  const frames = await extractFrames(mp4, outDir, timeline).catch(() => []);
  const gifArg = arg("--gif");
  const gif =
    gifArg !== undefined ? await makeGif(mp4, outDir, gifArg || "0-8").catch(() => undefined) : undefined;

  try {
    await writeReport({
      outDir,
      scenario,
      mode: live ? "live" : "scripted",
      display,
      width: size.width,
      height: size.height,
      fps,
      code,
      failure,
      startedAt: recordingStartedAt ?? startedAt,
      finishedAt,
      timeline,
      frames,
      gif,
    });

    if (!noBuild && !live) {
      process.stdout.write("[probe] restoring the production bundle\n");
      await run(process.execPath, ["esbuild.config.mjs", "production"]).catch(() => undefined);
    }
  } finally {
    if (xvfb && !keepDisplay) await stopProcess(xvfb, "SIGTERM");
  }

  if (failure) console.error(`[probe] ${failure}`);
  process.stdout.write(`[probe] report: ${path.join(outDir, "report.md")}\n`);
  if (existsSync(mp4)) process.stdout.write(`[probe] video: ${mp4}\n`);
  process.exitCode = code;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
