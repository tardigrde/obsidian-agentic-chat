import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import {
  assertDogfoodInvariants,
  generateDogfoodVault,
  writeDogfoodRunReport,
  writeManifest,
} from "./dogfood-core";

const DEFAULT_SPEC = "./test/e2e/dogfood/next-level.dogfood.ts";
const DEFAULT_REPORT_DIR = "logs/dogfood-runs";

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = args["run-id"] ?? timestampRunId();
  const reportDir = path.resolve(args["report-dir"] ?? DEFAULT_REPORT_DIR);
  const runDir = path.resolve(args["run-dir"] ?? path.join(reportDir, runId));
  const vaultPath = path.resolve(args.vault ?? path.join(runDir, "vault"));
  const externalRoot = path.resolve(args["external-root"] ?? path.join(runDir, "external-root"));
  const spec = args.spec ?? DEFAULT_SPEC;

  await mkdir(runDir, { recursive: true });
  const manifest = await generateDogfoodVault({
    vaultPath,
    externalRoot,
    runId,
    secretText: args.secret,
  });
  const manifestPath = await writeManifest(manifest);

  console.log(`Dogfood run: ${runId}`);
  console.log(`Vault: ${vaultPath}`);
  console.log(`External root: ${externalRoot}`);
  console.log(`Manifest: ${manifestPath}`);

  const e2eExitCode = await runE2e({
    manifestPath,
    vaultPath,
    externalRoot,
    spec,
    timeoutMs: args["timeout-ms"],
    turnTimeoutMs: args["turn-timeout-ms"],
  });

  if (e2eExitCode !== 0) process.exit(e2eExitCode);
  if (args["skip-post-invariants"] === "true") {
    console.log("Dogfood post-run synthetic invariant check skipped.");
    return;
  }

  const result = await assertDogfoodInvariants(manifest);
  const reportPath = await writeDogfoodRunReport(result, reportDir);
  console.log(`Dogfood report: ${reportPath}`);
  console.log(`Dogfood invariant status: ${result.ok ? "pass" : "fail"}`);

  if (!result.ok) process.exit(1);
}

function runE2e(options: {
  manifestPath: string;
  vaultPath: string;
  externalRoot: string;
  spec: string;
  timeoutMs?: string;
  turnTimeoutMs?: string;
}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(npmCommand(), ["run", "test:e2e"], {
      stdio: "inherit",
      env: {
        ...process.env,
        WDIO_CONFIG: "./wdio.dogfood.conf.mts",
        TARGET_VAULT: options.vaultPath,
        DOGFOOD_COPY: "false",
        DOGFOOD_SPEC: options.spec,
        DOGFOOD_FIXTURE_MANIFEST: options.manifestPath,
        DOGFOOD_EXTERNAL_ROOT: options.externalRoot,
        DOGFOOD_TIMEOUT_MS: options.timeoutMs ?? process.env.DOGFOOD_TIMEOUT_MS ?? "300000",
        DOGFOOD_TURN_TIMEOUT_MS: options.turnTimeoutMs ?? process.env.DOGFOOD_TURN_TIMEOUT_MS ?? "120000",
        NO_PROXY: mergeNoProxy(process.env.NO_PROXY),
      },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) throw new Error(`Unexpected argument: ${raw}`);
    const key = raw.slice(2);
    if (key === "skip-post-invariants") {
      parsed[key] = "true";
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function mergeNoProxy(current: string | undefined): string {
  const required = ["localhost", "127.0.0.1", "::1"];
  const values = new Set((current ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  for (const value of required) values.add(value);
  return [...values].join(",");
}

function timestampRunId(): string {
  return `dogfood-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}
