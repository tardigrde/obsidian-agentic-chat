#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  CHAOS_MODEL,
  ChaosGuardError,
  DEFAULT_CAPS,
  DEFAULT_DRY_RUN_CAPS,
  DEFAULT_EXPLORE_CAPS,
  assertChaosModel,
  PLAN_VERSION,
  SEED_MARKER,
  TEMP_PREFIX,
  assertSafeVaultPath,
  assertSeedMarker,
  parseCaps,
  redactSecrets,
  selectMode,
  type ChaosMode,
  type ChaosPlan,
} from "./chaos/monkey-core";
import { BUILTIN_CHARTERS } from "./chaos/explorer-core";
import { mineRun } from "./chaos/mine";
import { parseLlmName, resolveChaosLlm, resolvePluginLlm, type ChaosLlmName } from "./chaos/llm-provider";
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
  startXephyr,
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
  mode: ChaosMode;
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
  /** Run inside a nested Xephyr window on the user's desktop. */
  headed: boolean;
  /** Record a real display given with --display. Off by default: it captures the whole screen. */
  recordDisplay: boolean;
  model: string;
  baseUrl: string;
  mcpUrl?: string;
  apiKey?: string;
  /** The plugin under test cannot use the CLI; it always gets an HTTP endpoint. */
  pluginBaseUrl: string;
  pluginModel: string;
  pluginApiKey?: string;
  pluginKeySource: string;
  backend: "http" | "opencode";
  charter?: string;
  replayFile?: string;
  allowAnyModel: boolean;
  noMine: boolean;
  llm: ChaosLlmName;
  keySource: string;
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
  explorer?: { charter: string; model: string; replay: boolean; calls: number; tokens: number; cost: number; invalidReplies: number; summary?: string };
  plugin?: { tokens: number; cost: number; assistantMessages: number; models: string[] };
};

const CHAOS_SPEC = "test/e2e/chaos/chaos-monkey.e2e.ts";
const SESSION_DIR = "logs/chaos";
const BOOT_ALLOWANCE_MS = 120_000;
/** An explore step can wait up to 180 s for a live turn after the time cap is reached. */
const EXPLORE_GRACE_MS = 300_000;
const CHARTER_DIR = ".agents/skills/chaos-monkey/charters";

/** `--charter broad` reads the charter file; any other text is the charter itself. */
function resolveCharter(value: string | undefined): string {
  const name = (value ?? "broad").trim();
  const file = path.resolve(CHARTER_DIR, `${name}.md`);
  if (/^[\w-]+$/.test(name) && existsSync(file)) return readFileSync(file, "utf8").trim();
  if (BUILTIN_CHARTERS[name]) return BUILTIN_CHARTERS[name];
  if (existsSync(name)) return readFileSync(name, "utf8").trim();
  if (/^[\w-]+$/.test(name)) fail(`unknown charter ${name}; add ${CHARTER_DIR}/${name}.md or pass the charter text`);
  return name;
}

/** `--replay` takes a run folder or its explorer-decisions.jsonl. */
function resolveReplay(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = path.resolve(value);
  const file = existsSync(path.join(candidate, "explorer-decisions.jsonl"))
    ? path.join(candidate, "explorer-decisions.jsonl")
    : candidate;
  if (!existsSync(file)) fail(`--replay: ${file} does not exist`);
  return file;
}

function fail(message: string): never {
  console.error(`\n[chaos] ${message}`);
  process.exit(1);
}

function parseFps(value: string | undefined): number {
  const fps = Number(value ?? "15");
  if (!Number.isFinite(fps) || fps <= 0) fail(`--fps must be a positive number, got ${value}`);
  return fps;
}

function readKeyFile(): string | undefined {
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
  const llm = resolveChaosLlm(parseLlmName(readArg("--llm") ?? process.env.AGENTIC_CHAT_CHAOS_LLM));
  const plugin = resolvePluginLlm(llm);
  const apiKey =
    llm.apiKey ?? (llm.backend === "http" && llm.name === "openrouter" ? readKeyFile() : undefined);
  // The plugin endpoint is OpenRouter for `openrouter` and `opencode`; both may
  // take the key from a file.
  const pluginKeyFile = llm.name === "openrouter" || llm.name === "opencode";
  const pluginApiKey = plugin.apiKey ?? (pluginKeyFile ? readKeyFile() : undefined);

  if (live && llm.backend === "http" && !apiKey) {
    fail(
      llm.name === "openrouter"
        ? "--live needs AGENTIC_CHAT_API_KEY or AGENTIC_CHAT_API_KEY_FILE. Without it the runner only does a capped dry run."
        : "--live --llm opencode-go needs OPENCODE_GO_API_KEY (or an opencode-go key in opencode's auth.json).",
    );
  }
  if (live && !pluginApiKey) {
    fail(
      llm.name === "opencode"
        ? "--live --llm opencode still needs AGENTIC_CHAT_API_KEY (or AGENTIC_CHAT_API_KEY_FILE) for the plugin under test; the explorer and miner use the opencode CLI."
        : "--live needs AGENTIC_CHAT_API_KEY or AGENTIC_CHAT_API_KEY_FILE for the plugin under test.",
    );
  }

  const explore = selection.mode === "explore";
  const replayFile = resolveReplay(readArg("--replay"));
  if (explore && !live && !replayFile) {
    fail("--mode explore needs --live (a real explorer model) or --replay <run> (recorded decisions).");
  }

  const caps = parseCaps(
    {
      maxSteps: readArg("--max-steps"),
      maxSeconds: readArg("--max-seconds"),
      maxCalls: readArg("--max-calls"),
      maxTokens: readArg("--max-tokens"),
    },
    explore ? (live ? DEFAULT_EXPLORE_CAPS : { ...DEFAULT_EXPLORE_CAPS, maxTokens: 0 }) : live ? DEFAULT_CAPS : DEFAULT_DRY_RUN_CAPS,
  );

  if (live && caps.maxTokens <= 0) fail("--live needs a positive --max-tokens budget");

  // Live chaos is locked to one cheap model. The shared AGENTIC_CHAT_MODEL is
  // ignored on purpose: it may name an expensive model or openrouter/auto.
  const allowAnyModel = hasFlag("--allow-any-model");
  const model = assertChaosModel(
    readArg("--model") ?? (llm.model || CHAOS_MODEL),
    allowAnyModel,
  );
  const pluginModel = assertChaosModel(plugin.model, allowAnyModel);

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
    headed: hasFlag("--headed"),
    recordDisplay: hasFlag("--record-display"),
    model,
    baseUrl: llm.baseUrl,
    mcpUrl: process.env.AGENTIC_CHAT_CHAOS_MCP_URL?.trim() || process.env.AGENTIC_CHAT_E2E_MCP_URL?.trim(),
    apiKey,
    pluginBaseUrl: plugin.baseUrl,
    pluginModel,
    pluginApiKey,
    pluginKeySource: plugin.keySource,
    backend: llm.backend,
    charter: explore ? resolveCharter(readArg("--charter")) : undefined,
    replayFile,
    allowAnyModel,
    noMine: hasFlag("--no-mine"),
    llm: llm.name,
    keySource: llm.keySource,
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
    backend: options.backend,
    pluginBaseUrl: options.pluginBaseUrl,
    pluginModel: options.pluginModel,
    seededNotes: ["Welcome.md", "Notes/Seed.md", "Chaos Scratch.md"],
    mcpUrl: options.mcpUrl,
    charter: options.charter,
    replayFile: options.replayFile,
    size: options.size,
    allowAnyModel: options.allowAnyModel,
    llm: options.llm,
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
              `| ${step.id} | ${step.surface} | ${step.status} | ${redactSecrets(step.detail ?? "", [options.apiKey, options.pluginApiKey]) || "-"} |`,
          )
          .join("\n")
      : "| - | - | no steps executed | - |";
  const findingRows =
    findings.length > 0
      ? findings
          .map(
            (finding) =>
              `| ${finding.severity} | ${finding.step} | ${redactSecrets(finding.message, [options.apiKey, options.pluginApiKey])} |`,
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
              `| ${stringField(action.t)}s | ${stringField(action.step)} | ${stringField(action.status)} | ${redactSecrets(stringField(action.detail), [options.apiKey, options.pluginApiKey])} |`,
          )
          .join("\n")
      : "| - | - | - | no actions |";

  const text = `# Chaos monkey: ${options.mode}${options.target ? ` / ${options.target}` : ""}

- verdict: **${verdict}**
- mode: \`${options.mode}\`${options.target ? `, target \`${options.target}\`` : ""}
- model calls: ${driver?.calls ?? 0}
- ${options.mode === "explore" ? "tokens (real usage)" : "estimated tokens"}: ${driver?.tokens ?? 0}
- skipped steps: ${driver?.skippedSteps ?? steps.filter((step) => step.status === "skipped").length}
- stop reason: \`${driver?.stopReason ?? (result.timedOut ? "max-wall-time" : result.canceled ? "canceled" : "unknown")}\`
- live: \`${options.live}\`
- duration: ${(durationMs / 1000).toFixed(1)}s
- display: \`${result.display}\` ${options.size.width}x${options.size.height} @ ${options.fps}fps
- exit: ${result.code}${result.failure ? ` (${redactSecrets(result.failure, [options.apiKey, options.pluginApiKey])})` : ""}

## Hard caps

| cap | limit |
|---|---|
| steps | ${options.caps.maxSteps} |
| wall time | ${options.caps.maxSeconds}s |
| model calls | ${options.caps.maxCalls} |
| ${options.mode === "explore" ? "tokens (real usage)" : "estimated tokens"} | ${options.caps.maxTokens > 0 ? options.caps.maxTokens : "none (dry run)"} |
${explorerSection(options, driver)}

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

${[
  ...notes.map((note) => `- ${note}`),
  ...(options.live ? [] : ["- Dry run: scripted turns, not a real model. Never read this as a live model result."]),
].join("\n") || "- none"}

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
- \`sessions/\` copied session JSONL when the plugin wrote it${
    options.mode === "explore"
      ? "\n- `observations.jsonl` what the explorer saw at each step\n- `explorer-decisions.jsonl` recorded decisions; replay with `--replay <run>`\n- `findings.md`, `miner-report.json`, `issues/` mining output"
      : ""
  }
`;

  await writeFile(path.join(outDir, "report.md"), text);
}

function explorerSection(options: Options, driver: ReportDriver | undefined): string {
  if (options.mode !== "explore") return "";
  const explorer = driver?.explorer;
  const plugin = driver?.plugin;
  return `
## Explorer

- plugin endpoint: \`${options.pluginModel}\` (\`${options.pluginBaseUrl}\`, key from ${options.pluginKeySource})
- explorer/miner endpoint: \`${options.llm}\` (\`${options.baseUrl}\`, key from ${options.keySource})
- explorer model: \`${options.model}\`${options.replayFile ? ` (replay of \`${options.replayFile}\`)` : ""}
- explorer calls: ${explorer?.calls ?? 0}, tokens: ${explorer?.tokens ?? 0}, cost: $${(explorer?.cost ?? 0).toFixed(4)}, invalid replies: ${explorer?.invalidReplies ?? 0}
- plugin assistant messages: ${plugin?.assistantMessages ?? 0}, tokens: ${plugin?.tokens ?? 0}, models: ${plugin?.models.join(", ") || "-"}
- summary: ${explorer?.summary ? redactSecrets(explorer.summary, [options.apiKey, options.pluginApiKey]) : "(explorer did not finish with done)"}

Charter:

> ${(options.charter ?? "").split("\n").join("\n> ")}
`;
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
  if (options.headed && options.displayOverride) fail("--headed and --display cannot be combined");
  if (options.headed && !process.env.DISPLAY) fail("--headed needs a desktop session (DISPLAY is not set)");
  const needsXvfb = !options.displayOverride && !options.headed && process.platform === "linux";
  const xvfbPath = needsXvfb
    ? requireBinary("Xvfb", resolveBinary("Xvfb", process.env.XVFB_PATH), "Install it: sudo apt install xvfb", fail)
    : undefined;
  const xephyrPath = options.headed
    ? requireBinary(
        "Xephyr",
        resolveBinary("Xephyr", process.env.XEPHYR_PATH),
        "Install it: sudo apt install xserver-xephyr",
        fail,
      )
    : undefined;
  // A real display holds the user's other windows. Never record it unless asked.
  const record = !options.displayOverride || options.recordDisplay;

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
      }, options.caps.maxSeconds * 1000 + BOOT_ALLOWANCE_MS + (options.mode === "explore" ? EXPLORE_GRACE_MS : 0));

      try {
        if (options.displayOverride) {
          process.stderr.write(
            record
              ? "[chaos] WARNING: recording the whole real display, including other windows.\n"
              : "[chaos] not recording the real display (use --headed, or --record-display to capture the whole screen).\n",
          );
        } else if (options.headed) {
          xvfb = await startXephyr(xephyrPath as string, display, options.size.width, options.size.height);
          process.stdout.write(`[chaos] headed: watch the "Agentic Chat chaos" window (display ${display})\n`);
        } else {
          xvfb = await startXvfb(xvfbPath as string, display, options.size.width, options.size.height);
        }
        recordingStartedAt = Date.now();
        if (record) {
          ffmpeg = await startFfmpeg(ffmpegPath, display, options.size.width, options.size.height, options.fps, mp4);
        }

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
            AGENTIC_CHAT_API_KEY: options.pluginApiKey ?? "",
            AGENTIC_CHAT_BASE_URL: options.pluginBaseUrl,
            AGENTIC_CHAT_MODEL: options.pluginModel,
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

    if (
      options.mode === "explore" &&
      options.live &&
      !options.noMine &&
      (options.backend === "opencode" || options.apiKey) &&
      driver
    ) {
      process.stdout.write("[chaos] mining the run\n");
      try {
        const mined = await mineRun({
          runDir: options.outDir,
          apiKey: options.apiKey ?? "",
          baseUrl: options.baseUrl,
          model: options.model,
          llm: options.llm,
          backend: options.backend,
        });
        process.stdout.write(
          `[chaos] mined: ${mined.report.findings.length} findings, ${mined.drafts.length} issue drafts, cost ${
            options.backend === "opencode" ? "subscription" : `$${mined.cost.toFixed(4)}`
          }\n`,
        );
        process.stdout.write(`[chaos] findings: ${path.join(options.outDir, "findings.md")}\n`);
      } catch (error) {
        console.error(
          `[chaos] mining failed: ${redactSecrets(error instanceof Error ? error.message : String(error), [
            options.apiKey,
            options.pluginApiKey,
          ])}`,
        );
        console.error(`[chaos] retry: npm run chaos:mine -- ${options.outDir}`);
      }
    }

    if (result.failure) console.error(`[chaos] ${redactSecrets(result.failure, [options.apiKey, options.pluginApiKey])}`);
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
