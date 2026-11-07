#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

const CHAOS_SPEC = "test/e2e/chaos/chaos-monkey.e2e.ts";
const SESSION_DIR = "logs/chaos";
const BINARY_DIRS = ["/usr/bin", "/usr/local/bin", "/bin"];
const BOOT_ALLOWANCE_MS = 120_000;
const DEFAULT_MODEL = "openrouter/auto";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

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
  console.error(`\n[chaos] ${message}`);
  process.exit(1);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

function parseSize(value: string | undefined): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  if (!match) fail(`--size must look like 1440x1000, got ${value ?? "(missing)"}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseFps(value: string | undefined): number {
  const fps = Number(value ?? "15");
  if (!Number.isFinite(fps) || fps <= 0) fail(`--fps must be a positive number, got ${value}`);
  return fps;
}

/** Load .env without overriding an existing environment. */
function applyEnvFile(file: string): void {
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

function unwrapEnvValue(raw: string): string {
  const value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
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
  const selection = selectMode(arg("--mode"), arg("--target"));
  const live = has("--live");
  const apiKey = readApiKey();

  if (live && !apiKey) {
    fail(
      "--live needs AGENTIC_CHAT_API_KEY or AGENTIC_CHAT_API_KEY_FILE. " +
        "Without it the runner only does a capped dry run.",
    );
  }

  const dryRun = !live;
  const caps = parseCaps(
    {
      maxSteps: arg("--max-steps"),
      maxSeconds: arg("--max-seconds"),
      maxCalls: arg("--max-calls"),
      maxTokens: arg("--max-tokens"),
    },
    dryRun ? DEFAULT_DRY_RUN_CAPS : DEFAULT_CAPS,
  );

  if (live && caps.maxTokens <= 0) fail("--live needs a positive --max-tokens budget");

  return {
    ...selection,
    caps,
    live,
    noBuild: has("--no-build"),
    keep: has("--keep"),
    keepDisplay: has("--keep-display"),
    size: parseSize(arg("--size") ?? "1440x1000"),
    fps: parseFps(arg("--fps")),
    outDir: path.resolve(arg("--out") ?? path.join(SESSION_DIR, stamp())),
    displayOverride: arg("--display"),
    model: process.env.AGENTIC_CHAT_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: process.env.AGENTIC_CHAT_BASE_URL?.trim() || DEFAULT_BASE_URL,
    mcpUrl: process.env.AGENTIC_CHAT_CHAOS_MCP_URL?.trim() || process.env.AGENTIC_CHAT_E2E_MCP_URL?.trim(),
    apiKey,
  };
}

function resolveBinary(name: string, override: string | undefined): string | undefined {
  const explicit = override?.trim();
  if (explicit) return explicit;
  for (const dir of BINARY_DIRS) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function requireBinary(name: string, resolved: string | undefined, hint: string): string {
  if (!resolved) fail(`${name} is not installed. ${hint}`);
  return resolved;
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

async function stopProcess(child: ChildProcess | undefined, signal: NodeJS.Signals): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  if (await waitForExit(child, 8_000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2_000);
}

async function startXvfb(
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
  await waitFor(
    () => existsSync(`/tmp/.X11-unix/X${display.replace(":", "")}`),
    8_000,
    `Xvfb did not start on ${display}. ${stderr.trim()}`,
  );
  return child;
}

async function startFfmpeg(
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
  if (child.exitCode !== null) throw new Error(`ffmpeg exited before recording started. ${stderr.trim()}`);
  return child;
}

/**
 * Create the only vault the driver may open. The path comes from mkdtemp under
 * the OS temp root; there is no user-supplied vault option.
 */
async function createSeededVault(): Promise<{ seedRoot: string; vault: string }> {
  const seedRoot = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  const vault = assertSafeVaultPath(path.join(seedRoot, "vault"));
  assertSafeVaultPath(seedRoot);

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
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    const source = path.resolve(file);
    if (!existsSync(source)) throw new Error(`${file} is missing. Build first.`);
    await copyFile(source, path.join(pluginDir, file));
  }
}

async function writePlan(options: Options, vaultInfo: { seedRoot: string; vault: string }, outDir: string): Promise<string> {
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

async function writeReport(input: {
  options: Options;
  outDir: string;
  result: RunResult;
  driver?: {
    verdict?: string;
    stopReason?: string;
    steps?: Array<{ id: string; surface: string; status: string; detail?: string }>;
    findings?: Array<{ severity: string; step: string; message: string }>;
    runnerNotes?: string[];
    calls?: number;
    tokens?: number;
    assistantChars?: number;
    mcp?: { rendered: boolean; added: boolean };
    notes?: Array<{ path: string; exists: boolean }>;
    clock?: { startedAt: number; finishedAt: number };
  };
  actions: Array<Record<string, unknown>>;
}): Promise<void> {
  const { options, outDir, result, driver, actions } = input;
  const verdict = result.failure
    ? "INCONCLUSIVE"
    : driver?.verdict ?? "INCONCLUSIVE";
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
              `| ${String(action.t ?? "-")}s | ${String(action.step ?? "-")} | ${String(action.status ?? "-")} | ${redactSecrets(String(action.detail ?? ""), [options.apiKey]) || "-"} |`,
          )
          .join("\n")
      : "| - | - | - | no actions |";

  const text = `# Chaos monkey: ${options.mode}${options.target ? ` / ${options.target}` : ""}

- verdict: **${verdict}**
- mode: \`${options.mode}\`${options.target ? `, target \`${options.target}\`` : ""}
- model calls: ${driver?.calls ?? 0}
- estimated tokens: ${driver?.tokens ?? 0}
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

async function trimLeadIn(binary: string, mp4: string, outDir: string): Promise<void> {
  if (!existsSync(mp4)) return;
  let timeline: Array<{ t: number; label: string }>;
  try {
    timeline = JSON.parse(await readFile(path.join(outDir, "timeline.json"), "utf8"));
  } catch {
    return;
  }
  if (timeline.length === 0) return;
  const trim = Math.max(0, timeline[0].t - 0.25);
  if (trim < 0.1) return;

  const trimmed = mp4.replace(/\.mp4$/, "-trimmed.mp4");
  await run(
    binary,
    ["-y", "-loglevel", "error", "-ss", String(trim), "-i", mp4, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", trimmed],
    { allowFailure: true, quiet: true },
  );
  if (!existsSync(trimmed)) return;
  const raw = mp4.replace(/\.mp4$/, "-raw.mp4");
  await rename(mp4, raw);
  await rename(trimmed, mp4);
  const adjusted = timeline.map((entry) => ({ ...entry, t: Math.max(0, Number((entry.t - trim).toFixed(3))) }));
  await writeFile(path.join(outDir, "timeline.json"), `${JSON.stringify(adjusted, null, 2)}\n`);
}

async function extractFrames(binary: string, mp4: string, outDir: string): Promise<void> {
  let timeline: Array<{ t: number; label: string }>;
  try {
    timeline = JSON.parse(await readFile(path.join(outDir, "timeline.json"), "utf8"));
  } catch {
    return;
  }
  if (timeline.length === 0 || !existsSync(mp4)) return;
  const shotsDir = path.join(outDir, "shots");
  await mkdir(shotsDir, { recursive: true });
  for (const [index, entry] of timeline.entries()) {
    const name = `${String(index + 1).padStart(2, "0")}-${entry.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;
    await run(
      binary,
      ["-y", "-loglevel", "error", "-i", mp4, "-ss", String(entry.t), "-frames:v", "1", "-q:v", "2", path.join(shotsDir, name)],
      { allowFailure: true, quiet: true },
    );
  }
}

async function main(): Promise<void> {
  const envFile = path.resolve(".env");
  if (existsSync(envFile)) applyEnvFile(envFile);

  const options = parseOptions();
  const ffmpegPath = requireBinary("ffmpeg", resolveBinary("ffmpeg", process.env.FFMPEG_PATH), "Install it: sudo apt install ffmpeg");
  const needsXvfb = !options.displayOverride && process.platform === "linux";
  const xvfbPath = needsXvfb
    ? requireBinary("Xvfb", resolveBinary("Xvfb", process.env.XVFB_PATH), "Install it: sudo apt install xvfb")
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
      const display = options.displayOverride || `:${pickDisplay()}`;
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

    await trimLeadIn(ffmpegPath, result.mp4, options.outDir).catch(() => undefined);
    await extractFrames(ffmpegPath, result.mp4, options.outDir).catch(() => undefined);

    const driver = await readJson<Parameters<typeof writeReport>[0]["driver"]>(path.join(options.outDir, "driver-result.json"));
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
