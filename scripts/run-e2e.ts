import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import ObsidianLauncher from "obsidian-launcher";
import { parseObsidianVersions } from "wdio-obsidian-service";

const cacheDir = path.resolve(".obsidian-cache");
const wdioBin = path.resolve("node_modules/@wdio/cli/bin/wdio.js");
const driverPorts = [9515, 9516, 9517, 9518, 9519, 9520];
type DriverProcess = ChildProcessByStdio<null, Readable, Readable>;

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  maybeReexecWithProxySupport();

  const versions = await parseObsidianVersions(process.env.OBSIDIAN_VERSIONS ?? "latest/latest", { cacheDir });
  if (versions.length !== 1) {
    throw new Error(
      "The fixed-port e2e runner supports one Obsidian version pair at a time. " +
        "Set OBSIDIAN_VERSIONS to a single value, for example latest/latest.",
    );
  }

  const launcher = new ObsidianLauncher({ cacheDir });
  const [appVersion, installerVersionRequest] = versions[0];
  const [, installerVersion] = await launcher.resolveVersion(appVersion, installerVersionRequest);
  const chromedriverPath = await launcher.downloadChromedriver(installerVersion);

  const driver = await startChromedriver(chromedriverPath);
  const wdioExitCode = await runWdio(driver.port);
  driver.process.kill();
  process.exit(wdioExitCode);
}

function maybeReexecWithProxySupport(): void {
  if (!hasProxyEnv()) return;
  if (process.env.AGENTIC_CHAT_E2E_PROXY_REEXEC === "1") return;
  if (process.execArgv.includes("--use-env-proxy")) return;
  if (!nodeSupportsUseEnvProxy()) return;

  const result = spawnSync(
    process.execPath,
    ["--use-env-proxy", "--dns-result-order=ipv4first", "--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      env: { ...process.env, AGENTIC_CHAT_E2E_PROXY_REEXEC: "1" },
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

function hasProxyEnv(): boolean {
  return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some(
    (key) => !!process.env[key],
  );
}

function nodeSupportsUseEnvProxy(): boolean {
  const result = spawnSync(process.execPath, ["--use-env-proxy", "-e", ""], { stdio: "ignore" });
  return result.status === 0;
}

function localDriverEnv(): NodeJS.ProcessEnv {
  const driverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    NODE_OPTIONS: "",
  };

  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete driverEnv[key];
  }

  return driverEnv;
}

async function startChromedriver(binary: string): Promise<{ process: DriverProcess; port: number }> {
  const failures: string[] = [];

  for (const port of driverPorts) {
    const child = spawn(binary, [`--port=${port}`, "--allowed-origins=*", "--allowed-ips="], {
      env: localDriverEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = captureOutput(child);

    try {
      await waitForPort(child, port);
      return { process: child, port };
    } catch (error) {
      child.kill();
      failures.push(`:${port} ${error instanceof Error ? error.message : String(error)}\n${output()}`);
    }
  }

  throw new Error(`Could not start chromedriver on any fixed e2e port.\n${failures.join("\n")}`);
}

function captureOutput(child: DriverProcess): () => string {
  let output = "";
  const append = (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    if (process.env.WDIO_E2E_DRIVER_LOGS === "1") process.stderr.write(text);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return () => output.trim();
}

async function waitForPort(child: DriverProcess, port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`exited with code ${child.exitCode}`);
    if (await canConnect(port)) return;
    await sleep(100);
  }
  throw new Error("timed out waiting for driver port");
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runWdio(port: number): Promise<number> {
  return new Promise((resolve) => {
    const args = [
      ...(nodeSupportsUseEnvProxy() ? ["--use-env-proxy"] : []),
      "--dns-result-order=ipv4first",
      wdioBin,
      "run",
      "./wdio.conf.mts",
      ...process.argv.slice(2),
    ];
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        WDIO_EXTERNAL_CHROMEDRIVER_HOST: "127.0.0.1",
        WDIO_EXTERNAL_CHROMEDRIVER_PORT: String(port),
        WDIO_SKIP_DRIVER_SETUP: "1",
      },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
