#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const vaultPath = process.argv[2] ?? process.env.ANDROID_OBSIDIAN_VAULT;
const files = ["manifest.json", "main.js", "styles.css"];

if (!vaultPath) {
  console.error("usage: npm run install:android -- /sdcard/path/to/Vault");
  console.error("or set ANDROID_OBSIDIAN_VAULT=/sdcard/path/to/Vault");
  process.exit(1);
}

for (const file of files) {
  if (!existsSync(file)) {
    console.error(`${file} does not exist. Run npm run build first.`);
    process.exit(1);
  }
}

const pluginDir = `${vaultPath.replace(/\/+$/, "")}/.obsidian/plugins/agentic-chat`;
run("adb", ["shell", `mkdir -p ${shellQuote(pluginDir)}`]);

for (const file of files) {
  run("adb", ["push", file, `${pluginDir}/${file}`]);
}

console.warn(`Installed Agentic Chat assets into Android vault plugin dir: ${pluginDir}`);
console.warn("Open Obsidian Mobile, reload if needed, then enable Agentic Chat from Community plugins.");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
