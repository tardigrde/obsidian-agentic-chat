import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const watchMode = takeFlag("--watch");
const vaultArg = args.find((arg) => !arg.startsWith("-"));
const vaultPath = path.resolve(
  expandHome(vaultArg || process.env.AGENTIC_CHAT_VAULT || process.env.OBSIDIAN_VAULT || "~/MyTestVault"),
);
const pluginDir = path.join(vaultPath, ".obsidian", "plugins", "agentic-chat");

async function main(): Promise<void> {
  await assertVault(vaultPath);
  await mkdir(pluginDir, { recursive: true });
  await copyStaticArtifacts();
  await writeFile(path.join(pluginDir, ".hotreload"), "agentic-chat\n", "utf8");

  if (!watchMode) {
    await copyMainJs();
    printInstalled();
    return;
  }

  if (existsSync(path.join(root, "main.js"))) await copyMainJs();
  printInstalled();
  console.log("Watching plugin bundle. With pjeby/hot-reload enabled, Obsidian will reload after rebuilds.");
  watchStaticArtifacts();
  await runEsbuildWatch();
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

async function assertVault(vault: string): Promise<void> {
  const obsidianDir = path.join(vault, ".obsidian");
  try {
    const stats = await stat(obsidianDir);
    if (!stats.isDirectory()) throw new Error(`${obsidianDir} is not a directory.`);
  } catch {
    throw new Error(`Obsidian vault not found at ${vault}. Expected ${obsidianDir}.`);
  }
}

async function copyStaticArtifacts(): Promise<void> {
  await copyFile(path.join(root, "manifest.json"), path.join(pluginDir, "manifest.json"));
  await copyFile(path.join(root, "styles.css"), path.join(pluginDir, "styles.css"));
}

async function copyMainJs(): Promise<void> {
  const source = path.join(root, "main.js");
  if (!existsSync(source)) throw new Error("main.js does not exist. Run npm run build first, or use npm run dev:vault.");
  await copyFile(source, path.join(pluginDir, "main.js"));
}

function watchStaticArtifacts(): void {
  for (const fileName of ["manifest.json", "styles.css"]) {
    const source = path.join(root, fileName);
    let timer: NodeJS.Timeout | undefined;
    watch(source, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void copyFile(source, path.join(pluginDir, fileName)).catch((error: unknown) => {
          console.error(`Failed to copy ${fileName}:`, error);
        });
      }, 50);
    });
  }
}

async function runEsbuildWatch(): Promise<void> {
  const child = spawn(process.execPath, ["esbuild.config.mjs"], {
    cwd: root,
    env: { ...process.env, AGENTIC_CHAT_OUTFILE: path.join(pluginDir, "main.js") },
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 || signal) resolve();
      else reject(new Error(`esbuild watch exited with code ${code}`));
    });
  });
}

function printInstalled(): void {
  console.log(`Installed agentic-chat into ${pluginDir}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
