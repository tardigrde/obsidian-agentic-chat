#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  ChaosGuardError,
  DEFAULT_CAPS,
  DEFAULT_DRY_RUN_CAPS,
  PLAN_VERSION,
  SEED_MARKER,
  TEMP_PREFIX,
  assertSafeVaultPath,
  assertSeedMarker,
  parseCaps,
  redactSecrets,
  selectMode,
  type ChaosPlan,
} from "./chaos/monkey-core";
import {
  applyEnvFile,
  extractFrames,
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
} from "./live-support";

/**
 * Chaos-monkey runner.
 *
 * Creates a seeded throwaway vault, installs the built plugin, starts an
 * isolated X display and a full-screen recording, then runs the committed
 * in-app driver (`test/e2e/chaos/chaos-monkey.e2e.ts`) against it.
 *
 * Safety: never accepts a vault path. The vault is always a fresh
 * `<temp>/chaos-monkey-*` directory with a seed marker. Without
 * `--live` and an API key it runs a capped dry run that cannot spend tokens.
 */

type Options = {
  mode: "focused" | "generic";
  target?: string;
  caps: ReturnType<typeof parseCaps>;
  live: boolean;
  noBuild: boolean;
  keep: boolean;
  keepDisplay: boolean;
  size: { width: number; height: number };
  fps: number;
  outDir: string;
  displayOverride?: string;
  model: string;
  baseUrl: string;
  mcpUrl?: string;
  apiKey?: string;
};

type RunResult = {
  code: number;
  failure?: string;
  startedAt: number;
  recordingStartedAt?: number;
  display: string;
  mp4: string;
  xvfb?: ChildProcess;
  timedOut: boolean;
  canceled: boolean;
};

type ReportDriver = {
  verdict?: string;
  stopReason?: string;
  steps?: Array<{ id: string; surface: string; status: string; detail?: string }>;
  findings?: Array<{ severity: string; step: string; message: string }>;
  runnerNotes?: string[];
  calls?: number;
  tokens?: number;
  skippedSteps?: number;
  assistantChars?: number;
  mcp?: { rendered: boolean; added: boolean };
  notes?: Array<{ path: string; exists: boolean }>;
  clock?: { startedAt: number; finishedAt: number };
};

const CHAOS_SPEC = "test/e2e/chaos/chaos-monkey.e2e.ts";
const SESSION_DIR = "logs/chaos";
const BOOT_ALLOWANCE_MS = 120_000;
const DEFAULT_MODEL = "openrouter/auto";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function fail(message: string): never {
  console.error(`\n[chaos] ${message}`);
  process.exit(1);
}

function parseFps(value: string | undefined): number {
  const fps = Number(value ?? "15");
  if (!Number.isFinite(fps) || fps <= 0) fail(`--fps must be a positive number, got ${value}`);
  return fps;
}

function readApiKey(): string | undefined {
  const inline = process.env.AGENTIC_CHAT_API_KEY?.trim();
  if (inline) return inline;
  const file = process.env.AGENTIC_CHAT_API_KEY_FILE?.trim();
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseOptions(): Options {
  const selection = selectMode(readArg("--mode"), readArg("--target"));
  const live = hasFlag("--live");
  const apiKey = readApiKey();

  if (live && !apiKey) {
    fail(
      "--live needs AGENTIC_CHAT_API_KEY or AGENTIC_CHAT_API_KEY_FILE. " +
        "Without it the runner only does a capped dry run.",
    );
  }

  const caps = parseCaps(
    {
      maxSteps: readArg("--max-steps"),
      maxSeconds: readArg("--max-seconds"),
      maxCalls: readArg("--max-calls"),
      maxTokens: readArg("--max-tokens"),
    },
    live ? DEFAULT_CAPS : DEFAULT_DRY_RUN_CAPS,
  );

  if (live && caps.maxTokens <= 0) fail("--live needs a positive --max-tokens budget");

  return {
    ...selection,
    caps,
    live,
    noBuild: hasFlag("--no-build"),
    keep: hasFlag("--keep"),
    keepDisplay: hasFlag("--keep-display"),
    size: parseSize(readArg("--size") ?? "1440x1000", fail),
    fps: parseFps(readArg("--fps")),
    outDir: path.resolve(readArg("--out") ?? path.join(SESSION_DIR, stamp())),
    displayOverride: readArg("--display"),
    model: process.env.AGENTIC_CHAT_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: process.env.AGENTIC_CHAT_BASE_URL?.trim() || DEFAULT_BASE_URL,
    mcpUrl: process.env.AGENTIC_CHAT_CHAOS_MCP_URL?.trim() || process.env.AGENTIC_CHAT_E2E_MCP_URL?.trim(),
    apiKey,
  };
}

/**
 * Create the only vault the driver may open. The path comes from mkdtemp under
 * the OS temp root; there is no user-supplied vault option.
 */
async function createSeededVault(): Promise<{ seedRoot: string; vault: string }> {
  const seedRoot = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  const vault = assertSafeVaultPath(path.join(seedRoot, "vault"), os.tmpdir());
  assertSafeVaultPath(seedRoot, os.tmpdir());

  mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  mkdirSync(path.join(vault, ".obsidian", "plugins", "agentic-chat"), { recursive: true });
  mkdirSync(path.join(vault, "Notes"), { recursive: true });

  await writeFile(
    path.join(vault, "Welcome.md"),
    "# Chaos seed\n\nThis vault is disposable. The chaos monkey owns every file here.\n",
  );
  await writeFile(path.join(vault, "Notes", "Seed.md"), "# Seed note\n\nA read target for the driver.\n");
  await writeFile(path.join(vault, "Chaos Scratch.md"), "# Scratch\n\nWrite here if the model asks.\n");
  await writeFile(path.join(seedRoot, SEED_MARKER), "chaos-monkey\n");
  await writeFile(
    path.join(vault, ".obsidian", "app.json"),
    `${JSON.stringify({ alwaysUpdateLinks: true, newFileLocation: "folder", newFileFolderPath: "Notes" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(vault, ".obsidian", "community-plugins.json"),
    `${JSON.stringify(["agentic-chat"], null, 2)}\n`,
  );
  await writeFile(
    path.join(vault, ".obsidian", "core-plugins.json"),
    `${JSON.stringify(["file-explorer", "global-search", "switcher", "command-palette"], null, 2)}\n`,
  );

  return { seedRoot, vault };
}

async function installPlugin(vault: string): Promise<void> {
  const pluginDir = path.join(vault, ".obsidian", "plugins", "agentic-chat");
  await Promise.all(
    ["main.js", "manifest.json", "styles.css"].map(async (file) => {
      const source = path.resolve(file);
      if (!existsSync(source)) throw new Error(`${file} is missing. Build first.`);
      await copyFile(source, path.join(pluginDir, file));
    }),
  );
}

async function writePlan(
  options: Options,
  vaultInfo: { seedRoot: string; vault: string },
  outDir: string,
): Promise<string> {
  const plan: ChaosPlan = {
    version: PLAN_VERSION,
    mode: options.mode,
    target: options.target as ChaosPlan["target"],
    caps: options.caps,
    live: options.live,
    startedAt: Date.now(),
    outDir,
    cancelFile: path.join(outDir, "CANCEL"),
    seed: Math.floor(Date.now() % 2_147_483_647),
    model: options.model,
    baseUrl: options.baseUrl,
    seededNotes: ["Welcome.md", "Notes/Seed.md", "Chaos Scratch.md"],
    mcpUrl: options.mcpUrl,
  };
  const planPath = path.join(outDir, "plan.json");
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(
    path.join(outDir, "vault-info.json"),
    `${JSON.stringify(
      {
        seedRoot: vaultInfo.seedRoot,
        vault: vaultInfo.vault,
        guard: "temp-only, marker-checked, never a user vault",
        seededNotes: plan.seededNotes,
        mode: plan.mode,
        target: plan.target,
        live: plan.live,
      },
      null,
      2,
    )}\n`,
  );
  return planPath;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readActionLog(outDir: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(path.join(outDir, "action-log.jsonl"), "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "-";
}

async function writeReport(input: {
  options: Options;
  outDir: string;
  result: RunResult;
  driver?: ReportDriver;
  actions: Array<Record<string, unknown>>;
}): Promise<void> {
  const { options, outDir, result, driver, actions } = input;
  // A non-zero child exit means the harness did not complete cleanly, even if a
  // stale driver result claims PASS.
  const verdict = result.failure || result.code !== 0 ? "INCONCLUSIVE" : (driver?.verdict ?? "INCONCLUSIVE");
  const steps = driver?.steps ?? [];
  const findings = driver?.findings ?? [];
  const notes = driver?.runnerNotes ?? [];
  const stepRows =
    steps.length > 0
      ? steps
          .map(
            (step) =>
              `| ${step.id} | ${step.surface} | ${step.status} | ${redactSecrets(step.detail ?? "", [options.apiKey]) || "-"} |`,
          )
          .join("\n")
      : "| - | - | no steps executed | - |";
  const findingRows =
    findings.length > 0
      ? findings
          .map(
            (finding) =>
              `| ${finding.severity} | ${finding.step} | ${redactSecrets(finding.message, [options.apiKey])} |`,
          )
          .join("\n")
      : "| - | - | none |";
  const durationMs = (driver?.clock?.finishedAt ?? Date.now()) - result.startedAt;
  const logRows =
    actions.length > 0
      ? actions
          .slice(-40)
          .map(
            (action) =>
              `| ${stringField(action.t)}s | ${stringField(action.step)} | ${stringField(action.status)} | ${redactSecrets(stringField(action.detail), [options.apiKey])} |`,
          )
          .join("\n")
      : "| - | - | - | no actions |";

  const text = `# Chaos monkey: ${options.mode}${options.target ? ` / ${options.target}` : ""}

- verdict: **${verdict}**
- mode: \`${options.mode}\`${options.target ? `, target \`${options.target}\`` : ""}
- model calls: ${driver?.calls ?? 0}
- estimated tokens: ${driver?.tokens ?? 0}
- skipped steps: ${driver?.skippedSteps ?? steps.filter((step) => step.status === "skipped").length}
- stop reason: \`${driver?.stopReason ?? (result.timedOut ? "max-wall-time" : result.canceled ? "canceled" : "unknown")}\`
- live: \`${options.live}\`
- duration: ${(durationMs / 1000).toFixed(1)}s
- display: \`${result.display}\` ${options.size.width}x${options.size.height} @ ${options.fps}fps
- exit: ${result.code}${result.failure ? ` (${redactSecrets(result.failure, [options.apiKey])})` : ""}

## Hard caps

| cap | limit |
|---|---|
| steps | ${options.caps.maxSteps} |
| wall time | ${options.caps.maxSeconds}s |
| model calls | ${options.caps.maxCalls} |
| estimated tokens | ${options.caps.maxTokens} |

## Safety

- Vault is a fresh temp directory with the \`${TEMP_PREFIX}\` prefix and a \`${SEED_MARKER}\` marker.
- No user vault path is accepted; \`assertSafeVaultPath\` runs before launch.
- Live mode requires an API key environment variable. Without it the run is a capped dry run.
- Key material is redacted from the report and action log.
- Cleanup removes the seed root unless \`--keep\` is passed.

## Steps

| step | surface | status | detail |
|---|---|---|---|
${stepRows}

## Findings

| severity | step | message |
|---|---|---|
${findingRows}

## Notes and limitations

${notes.length > 0 ? notes.map((note) => `- ${note}`).join("\n") : "- none"}
${options.live ? "" : "- Dry run: scripted turns, not a real model. Never read this as a live model result.\n"}
## Action log (tail)

| t | step | status | detail |
|---|---|---|---|
${logRows}

## Artifacts

- \`session.mp4\` whole-display recording
- \`shots/\` screenshots and keyframes
- \`action-log.jsonl\`
- \`driver-result.json\`
- \`metrics.json\`
- \`plan.json\`
- \`vault-info.json\`
- \`sessions/\` copied session JSONL when the plugin wrote it
`;

  await writeFile(path.join(outDir, "report.md"), text);
}

async function main(): Promise<void> {
  const envFile = path.resolve(".env");
  if (existsSync(envFile)) applyEnvFile(envFile);

  const options = parseOptions();
  const ffmpegPath = requireBinary(
    "ffmpeg",
    resolveBinary("ffmpeg", process.env.FFMPEG_PATH),
    "Install it: sudo apt install ffmpeg",
    fail,
  );
  const needsXvfb = !options.displayOverride && process.platform === "linux";
  const xvfbPath = needsXvfb
    ? requireBinary("Xvfb", resolveBinary("Xvfb", process.env.XVFB_PATH), "Install it: sudo apt install xvfb", fail)
    : undefined;

  await mkdir(options.outDir, { recursive: true });
  const { seedRoot, vault } = await createSeededVault();
  assertSeedMarker(path.join(seedRoot, SEED_MARKER));

  try {
    process.stdout.write("[chaos] mode: ");
    process.stdout.write(options.mode);
    if (options.target) process.stdout.write(` / ${options.target}`);
    process.stdout.write("\n");
    process.stdout.write(`[chaos] live: ${options.live}${options.live ? "" : " (capped dry run)"}\n`);
    process.stdout.write(`[chaos] caps: ${JSON.stringify(options.caps)}\n`);
    process.stdout.write(`[chaos] vault: ${vault}\n`);
    process.stdout.write(`[chaos] output: ${options.outDir}\n`);
    process.stdout.write(`[chaos] kill switch: touch ${path.join(options.outDir, "CANCEL")}\n`);

    const signalState = { canceled: false, timedOut: false };
    let child: ChildProcess | undefined;
    const cancel = (signal: NodeJS.Signals): void => {
      signalState.canceled = true;
      try {
        writeFileSync(path.join(options.outDir, "CANCEL"), signal);
      } catch {
        // Output dir may not exist yet; the driver will still stop on the next cap.
      }
      child?.kill("SIGTERM");
    };
    const onSigint = (): void => cancel("SIGINT");
    const onSigterm = (): void => cancel("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    let result: RunResult;
    try {
      if (!options.noBuild) {
        process.stdout.write(`[chaos] building ${options.live ? "production" : "e2e"} bundle\n`);
        if (options.live) await run(process.execPath, ["esbuild.config.mjs", "production"]);
        else await run(process.execPath, ["scripts/build-e2e.mjs"]);
      }
      await installPlugin(vault);
      const planPath = await writePlan(options, { seedRoot, vault }, options.outDir);

      const mp4 = path.join(options.outDir, "session.mp4");
      const display = options.displayOverride || `:${pickDisplay(fail)}`;
      const startedAt = Date.now();
      let xvfb: ChildProcess | undefined;
      let ffmpeg: ChildProcess | undefined;
      let recordingStartedAt: number | undefined;
      let code = 1;
      let failure: string | undefined;
      const wallTimer = setTimeout(() => {
        signalState.timedOut = true;
        try {
          writeFileSync(path.join(options.outDir, "CANCEL"), "max-wall-time\n");
        } catch {
          // The out dir exists by now.
        }
        child?.kill("SIGTERM");
      }, options.caps.maxSeconds * 1000 + BOOT_ALLOWANCE_MS);

      try {
        if (options.displayOverride) {
          process.stderr.write("[chaos] recording an existing display.\n");
        } else {
          xvfb = await startXvfb(xvfbPath as string, display, options.size.width, options.size.height);
        }
        recordingStartedAt = Date.now();
        ffmpeg = await startFfmpeg(ffmpegPath, display, options.size.width, options.size.height, options.fps, mp4);

        child = spawn(process.execPath, ["--import", "tsx", "scripts/run-e2e.ts", "--spec", CHAOS_SPEC], {
          env: {
            ...process.env,
            DISPLAY: display,
            AGENTIC_CHAT_CHAOS: "1",
            AGENTIC_CHAT_CHAOS_PLAN: planPath,
            AGENTIC_CHAT_CHAOS_OUT: options.outDir,
            AGENTIC_CHAT_E2E_VAULT: vault,
            AGENTIC_CHAT_PROBE_OUT: options.outDir,
            AGENTIC_CHAT_PROBE_STARTED_AT: String(recordingStartedAt),
            AGENTIC_CHAT_E2E_WINDOW_SIZE: `${options.size.width}x${options.size.height}`,
            AGENTIC_CHAT_E2E_HEADLESS: "0",
            AGENTIC_CHAT_E2E_MOBILE_VIEWPORT: "0",
            WDIO_MAX_INSTANCES: "1",
            AGENTIC_CHAT_API_KEY: options.apiKey ?? "",
            AGENTIC_CHAT_BASE_URL: options.baseUrl,
            AGENTIC_CHAT_MODEL: options.model,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
        child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

        await new Promise<void>((resolve) => {
          child?.on("close", (exitCode) => {
            code = exitCode ?? 1;
            resolve();
          });
          child?.on("error", (error) => {
            failure = error.message;
            resolve();
          });
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(wallTimer);
        await stopProcess(ffmpeg, "SIGINT");
      }

      result = {
        code,
        failure,
        startedAt,
        recordingStartedAt,
        display,
        mp4,
        xvfb,
        timedOut: signalState.timedOut,
        canceled: signalState.canceled,
      };
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }

    await stopProcess(result.xvfb, options.keepDisplay ? "SIGKILL" : "SIGTERM");
    if (result.xvfb && options.keepDisplay) {
      process.stdout.write(`[chaos] display left running: ${result.display}\n`);
    }

    const timeline = await readTimeline(options.outDir);
    await trimLeadIn(ffmpegPath, result.mp4, options.outDir, timeline).catch(() => undefined);
    const adjusted = await readTimeline(options.outDir);
    await extractFrames(ffmpegPath, result.mp4, options.outDir, adjusted).catch(() => undefined);

    const driver = await readJson<ReportDriver>(path.join(options.outDir, "driver-result.json"));
    const actions = await readActionLog(options.outDir);
    await writeReport({ options, outDir: options.outDir, result, driver, actions });

    if (result.failure) console.error(`[chaos] ${redactSecrets(result.failure, [options.apiKey])}`);
    process.stdout.write(`[chaos] report: ${path.join(options.outDir, "report.md")}\n`);
    if (existsSync(result.mp4)) process.stdout.write(`[chaos] video: ${result.mp4}\n`);

    if (signalState.canceled) process.exitCode = 130;
    else if (result.failure) process.exitCode = 1;
    else process.exitCode = result.code;
  } finally {
    if (options.keep) {
      process.stdout.write(`[chaos] kept seed vault: ${vault}\n`);
    } else {
      await rm(seedRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof ChaosGuardError) {
    console.error(`\n[chaos] ${error.message}`);
    process.exit(1);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
