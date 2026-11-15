#!/usr/bin/env node
// Placeholder: the witness test must fail on its assertions, not on a missing
// module. The implementation follows in the next commit.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export function findRepoRoot(startDir = process.cwd()) {
  return path.resolve(startDir);
}

export function parseEnvFile() {
  return [];
}

export function collectSecrets() {
  return [];
}

export function redactText(text) {
  return String(text);
}

export function countSecrets() {
  return 0;
}

export function createLineRedactor(redact) {
  return {
    push(chunk) {
      return redact(String(chunk));
    },
    flush() {
      return "";
    },
  };
}

export function createRedactor() {
  return { secrets: [], redact: (text) => String(text) };
}

function main() {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf("--file");
  const inPlace = args.includes("--in-place");
  if (fileIndex >= 0) {
    const file = args[fileIndex + 1];
    if (!file) throw new Error("--file needs a path");
    const text = readFileSync(file, "utf8");
    if (inPlace) {
      writeFileSync(file, text);
      return;
    }
    process.stdout.write(text);
    return;
  }
  process.stdin.pipe(process.stdout);
}

main();
