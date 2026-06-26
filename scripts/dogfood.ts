import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const once = takeFlag("--once");
const noOpen = takeFlag("--no-open");
const noTail = takeFlag("--no-tail");
const vaultArg = args.find((arg) => !arg.startsWith("-"));
const vaultPath = path.resolve(
  expandHome(vaultArg || process.env.AGENTIC_CHAT_VAULT || process.env.OBSIDIAN_VAULT || "~/MyTestVault"),
);
const obsidianDir = path.join(vaultPath, ".obsidian");
const pluginRoot = path.join(obsidianDir, "plugins");
const pluginDir = path.join(pluginRoot, "agentic-chat");

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  await assertVault();
  await mkdir(pluginDir, { recursive: true });
  await enableCommunityPlugin("agentic-chat");
  const hotReloadIds = await enableHotReloadWhenPresent();
  printSetup(hotReloadIds);

  if (!noTail) startLogTailers();

  if (once) {
    await run("npm", ["run", "build"]);
    await run(process.execPath, ["--import", "tsx", "scripts/install-local.ts", vaultPath]);
    await openVault();
    return;
  }

  const child = spawn(process.execPath, ["--import", "tsx", "scripts/install-local.ts", "--watch", vaultPath], {
    cwd: root,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  let opened = false;
  const relay = (chunk: Buffer, stream: NodeJS.WriteStream) => {
    const text = chunk.toString();
    stream.write(text);
    if (!opened && text.includes("Installed agentic-chat into")) {
      opened = true;
      void openVault();
    }
  };
  child.stdout.on("data", (chunk: Buffer) => relay(chunk, process.stdout));
  child.stderr.on("data", (chunk: Buffer) => relay(chunk, process.stderr));

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 || signal) resolve();
      else reject(new Error(`dogfood watcher exited with code ${code}`));
    });
  });
}

function takeFlag(flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function assertVault(): Promise<void> {
  try {
    const stats = await stat(obsidianDir);
    if (!stats.isDirectory()) throw new Error(`${obsidianDir} is not a directory.`);
  } catch {
    throw new Error(`Obsidian vault not found at ${vaultPath}. Expected ${obsidianDir}.`);
  }
}

async function enableCommunityPlugin(pluginId: string): Promise<void> {
  const file = path.join(obsidianDir, "community-plugins.json");
  const ids = await readCommunityPlugins(file);
  if (ids.includes(pluginId)) return;
  ids.push(pluginId);
  await writeFile(file, `${JSON.stringify(ids, null, 2)}\n`, "utf8");
  console.log(`Enabled ${pluginId} in ${file}`);
}

async function readCommunityPlugins(file: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

async function enableHotReloadWhenPresent(): Promise<string[]> {
  if (!existsSync(pluginRoot)) return [];
  const ids: string[] = [];
  for (const entry of await readdir(pluginRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "agentic-chat") continue;
    const manifest = await readManifest(path.join(pluginRoot, entry.name, "manifest.json"));
    if (!manifest) continue;
    const id = typeof manifest.id === "string" ? manifest.id : entry.name;
    const name = typeof manifest.name === "string" ? manifest.name : "";
    if (isHotReloadPlugin(id, name)) ids.push(id);
  }

  for (const id of ids) await enableCommunityPlugin(id);
  return ids;
}

async function readManifest(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isHotReloadPlugin(id: string, name: string): boolean {
  const normalized = `${id} ${name}`.toLowerCase();
  return normalized.includes("hot") && normalized.includes("reload");
}

function printSetup(hotReloadIds: string[]): void {
  console.log(`Dogfood vault: ${vaultPath}`);
  console.log(`Plugin dir: ${pluginDir}`);
  if (hotReloadIds.length > 0) {
    console.log(`Hot reload enabled: ${hotReloadIds.join(", ")}`);
  } else {
    console.log("Hot reload plugin not found. Use Obsidian DevTools to reload manually if needed:");
    console.log('await app.plugins.disablePlugin("agentic-chat"); await app.plugins.enablePlugin("agentic-chat");');
  }
  console.log(once ? "Mode: one-shot build/install" : "Mode: watch and rebuild into the vault");
}

async function openVault(): Promise<void> {
  if (noOpen) return;
  const uri = `obsidian://open?path=${encodeURIComponent(vaultPath)}`;
  const command = openCommand(uri);
  if (!command) {
    console.log(`Open Obsidian manually: ${uri}`);
    return;
  }

  try {
    const child = spawn(command.bin, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.log(`Opening Obsidian vault: ${uri}`);
  } catch (error) {
    console.log(`Open Obsidian manually: ${uri}`);
    console.warn(error instanceof Error ? error.message : String(error));
  }
}

function openCommand(uri: string): { bin: string; args: string[] } | undefined {
  if (process.platform === "darwin") return { bin: "open", args: [uri] };
  if (process.platform === "win32") return { bin: "cmd.exe", args: ["/c", "start", "", uri] };
  if (isWsl()) return { bin: "cmd.exe", args: ["/c", "start", "", uri] };
  return { bin: "xdg-open", args: [uri] };
}

function isWsl(): boolean {
  try {
    return readFileSyncText("/proc/version").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function readFileSyncText(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function startLogTailers(): void {
  const tailer = new Tailer([
    { label: "session", dir: path.join(pluginDir, "sessions"), extensions: [".jsonl"] },
    { label: "e2e", dir: path.join(root, "logs", "e2e-artifacts"), extensions: [".json", ".jsonl", ".log", ".txt"] },
  ]);
  tailer.start();
}

class Tailer {
  private offsets = new Map<string, number>();

  constructor(
    private readonly roots: Array<{
      label: string;
      dir: string;
      extensions: string[];
    }>,
  ) {}

  start(): void {
    console.log("Tailing local session JSONL and e2e artifacts. Press Ctrl+C to stop.");
    void this.scan(true);
    setInterval(() => void this.scan(false), 1_500);
  }

  private async scan(seed: boolean): Promise<void> {
    for (const rootInfo of this.roots) {
      for (const file of await listFiles(rootInfo.dir, rootInfo.extensions)) {
        const stats = await stat(file);
        const previous = this.offsets.get(file);
        if (previous === undefined) {
          this.offsets.set(file, seed ? stats.size : 0);
          continue;
        }
        if (stats.size <= previous) continue;
        const content = await readFile(file, "utf8");
        this.offsets.set(file, stats.size);
        const chunk = content.slice(previous).trim();
        if (chunk) console.log(`\n[${rootInfo.label}] ${path.relative(root, file)}\n${chunk}`);
      }
    }
  }
}

async function listFiles(dir: string, extensions: string[]): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return await listFiles(entryPath, extensions);
        if (entry.isFile() && extensions.includes(path.extname(entry.name))) return [entryPath];
        return [];
      }),
    );
    return files.flat();
  } catch {
    return [];
  }
}

function run(command: string, commandArgs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${commandArgs.join(" ")} exited with code ${code}`));
    });
  });
}
