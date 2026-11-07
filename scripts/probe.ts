#!/usr/bin/env node
import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  applyEnvFile,
  extractFrames,
  formatDuration,
  hasFlag,
  parseSize,
  pickDisplay,
  readArg,
  readTimeline,
  requireBinary,
  resolveBinary,
  run,
  startFfmpeg,
  startXvfb,
  stamp,
  stopProcess,
  trimLeadIn,
  type TimelineEntry,
} from "./live-support";

type Options = {
  scenario: string;
  live: boolean;
  noBuild: boolean;
  keepDisplay: boolean;
  size: { width: number; height: number };
  fps: number;
  displayOverride?: string;
  gif?: string;
  outDir: string;
};

type ProbeRun = {
  code: number;
  failure?: string;
  startedAt: number;
  recordingStartedAt?: number;
  display: string;
  mp4: string;
  xvfb?: ChildProcess;
};

const SCENARIO_DIR = path.resolve("test/e2e/probe/scenarios");

function fail(message: string): never {
  console.error(`\n[probe] ${message}`);
  process.exit(1);
}

function parseTime(value: string): number {
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  const parts = value.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) fail(`invalid time: ${value}`);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Resolve a binary from fixed, unwriteable directories instead of trusting PATH.
 * Set FFMPEG_PATH or XVFB_PATH to override.
 */
async function listScenarios(): Promise<string[]> {
  const entries = await readdir(SCENARIO_DIR);
  return entries.filter((entry) => entry.endsWith(".e2e.ts")).map((entry) => entry.replace(/\.e2e\.ts$/, ""));
}

async function makeGif(binary: string, mp4: string, outDir: string, range: string): Promise<string | undefined> {
  const [startRaw, endRaw] = range.split("-");
  const start = parseTime(startRaw || "0");
  const end = endRaw ? parseTime(endRaw) : start + 8;
  const duration = Math.max(0.5, end - start);
  const target = path.join(outDir, "key.gif");

  await run(
    binary,
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
  trimMs?: number;
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
- lead-in trimmed: ${input.trimMs ? formatDuration(input.trimMs) : "none"}
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

function parseOptions(): Options {
  const scenarioArg = readArg("--scenario");
  if (!scenarioArg) fail("--scenario is required. Run: npm run probe -- --list");

  const scenario = scenarioArg.includes("/") || scenarioArg.endsWith(".ts")
    ? path.resolve(scenarioArg)
    : path.join(SCENARIO_DIR, `${scenarioArg}.e2e.ts`);
  if (!existsSync(scenario)) fail(`scenario not found: ${scenario}`);

  const fps = Number(readArg("--fps") ?? "15");
  if (!Number.isFinite(fps) || fps <= 0) fail(`--fps must be a positive number, got ${readArg("--fps")}`);

  const live = hasFlag("--live");
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

  return {
    scenario,
    live,
    noBuild: hasFlag("--no-build"),
    keepDisplay: hasFlag("--keep-display"),
    size: parseSize(readArg("--size") ?? "1440x1000", fail),
    fps,
    displayOverride: readArg("--display"),
    gif: readArg("--gif"),
    outDir: path.resolve(
      readArg("--out") ?? path.join("logs", "probes", `${stamp()}-${path.basename(scenario, ".e2e.ts")}`),
    ),
  };
}

function resolveBinaries(options: Options): { ffmpeg: string; xvfb?: string } {
  const ffmpeg = requireBinary(
    "ffmpeg",
    resolveBinary("ffmpeg", process.env.FFMPEG_PATH),
    "Install it: sudo apt install ffmpeg",
    fail,
  );

  if (options.displayOverride) return { ffmpeg };
  if (process.platform !== "linux") {
    fail("probes need Xvfb on Linux. Pass --display to record an existing display.");
  }

  return {
    ffmpeg,
    xvfb: requireBinary(
      "Xvfb",
      resolveBinary("Xvfb", process.env.XVFB_PATH),
      "Install it: sudo apt install xvfb. Or pass --display :0 to record your desktop.",
      fail,
    ),
  };
}

async function runProbe(options: Options, ffmpegPath: string, xvfbPath: string | undefined): Promise<ProbeRun> {
  const mp4 = path.join(options.outDir, "session.mp4");
  const display = options.displayOverride || `:${pickDisplay(fail)}`;
  const startedAt = Date.now();
  let xvfb: ChildProcess | undefined;
  let ffmpeg: ChildProcess | undefined;
  let recordingStartedAt: number | undefined;
  let code = 1;
  let failure: string | undefined;

  try {
    if (!options.noBuild) {
      process.stdout.write(`[probe] building ${options.live ? "production" : "e2e"} bundle\n`);
      if (options.live) await run(process.execPath, ["esbuild.config.mjs", "production"]);
      else await run(process.execPath, ["scripts/build-e2e.mjs"]);
    }

    if (options.displayOverride) {
      process.stderr.write("[probe] recording an existing display; every window on it will be in frame.\n");
    } else {
      xvfb = await startXvfb(xvfbPath as string, display, options.size.width, options.size.height);
    }

    recordingStartedAt = Date.now();
    ffmpeg = await startFfmpeg(
      ffmpegPath,
      display,
      options.size.width,
      options.size.height,
      options.fps,
      mp4,
    );

    code = await run(
      process.execPath,
      ["--import", "tsx", "scripts/run-e2e.ts", "--spec", options.scenario],
      {
        allowFailure: true,
        env: {
          DISPLAY: display,
          AGENTIC_CHAT_PROBE: "1",
          AGENTIC_CHAT_PROBE_OUT: options.outDir,
          AGENTIC_CHAT_PROBE_LIVE: options.live ? "1" : "0",
          AGENTIC_CHAT_PROBE_STARTED_AT: String(recordingStartedAt),
          AGENTIC_CHAT_E2E_WINDOW_SIZE: `${options.size.width}x${options.size.height}`,
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

  return { code, failure, startedAt, recordingStartedAt, display, mp4, xvfb };
}

async function finalize(options: Options, result: ProbeRun, ffmpegPath: string): Promise<void> {
  const finishedAt = Date.now();
  const rawTimeline = await readTimeline(options.outDir);
  const trimmed = await trimLeadIn(ffmpegPath, result.mp4, options.outDir, rawTimeline).catch(() => ({
    timeline: rawTimeline,
    trimMs: 0,
  }));
  const timeline = trimmed.timeline;
  const frames = await extractFrames(ffmpegPath, result.mp4, options.outDir, timeline).catch(() => []);
  const gif =
    options.gif !== undefined
      ? await makeGif(ffmpegPath, result.mp4, options.outDir, options.gif || "0-8").catch(() => undefined)
      : undefined;

  try {
    await writeReport({
      outDir: options.outDir,
      scenario: options.scenario,
      mode: options.live ? "live" : "scripted",
      display: result.display,
      width: options.size.width,
      height: options.size.height,
      fps: options.fps,
      code: result.code,
      failure: result.failure,
      startedAt: (result.recordingStartedAt ?? result.startedAt) + trimmed.trimMs,
      finishedAt,
      timeline,
      frames,
      gif,
      trimMs: trimmed.trimMs,
    });

    if (!options.noBuild && !options.live) {
      process.stdout.write("[probe] restoring the production bundle\n");
      await run(process.execPath, ["esbuild.config.mjs", "production"]).catch(() => undefined);
    }
  } finally {
    if (result.xvfb && !options.keepDisplay) await stopProcess(result.xvfb, "SIGTERM");
  }
}

async function main(): Promise<void> {
  if (hasFlag("--list")) {
    for (const scenario of await listScenarios()) process.stdout.write(`${scenario}\n`);
    return;
  }

  const envFile = path.resolve(".env");
  if (existsSync(envFile)) applyEnvFile(envFile);

  const options = parseOptions();
  const binaries = resolveBinaries(options);
  await mkdir(options.outDir, { recursive: true });

  process.stdout.write(`[probe] ${path.basename(options.scenario)}\n`);
  process.stdout.write(`[probe] mode: ${options.live ? "live" : "scripted"}\n`);
  process.stdout.write(`[probe] display: ${options.displayOverride ?? "auto"} ${options.size.width}x${options.size.height}\n`);
  process.stdout.write(`[probe] output: ${options.outDir}\n`);

  const result = await runProbe(options, binaries.ffmpeg, binaries.xvfb);
  await finalize(options, result, binaries.ffmpeg);

  if (result.failure) console.error(`[probe] ${result.failure}`);
  process.stdout.write(`[probe] report: ${path.join(options.outDir, "report.md")}\n`);
  if (existsSync(result.mp4)) process.stdout.write(`[probe] video: ${result.mp4}\n`);
  process.exitCode = result.code;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
