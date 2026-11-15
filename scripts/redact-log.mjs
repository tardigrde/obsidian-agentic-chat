#!/usr/bin/env node
/**
 * Redact secrets before they reach a log sink.
 *
 * One implementation for the verify and delegate scripts: exact values from
 * `process.env` and the repo `.env`, plus the key shapes from the incident.
 * The CLI is line-buffered, so a key inside a long JSON line is caught even
 * when a chunk boundary splits it. It never prints a value, only the label.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const LABELS = {
  openrouter: "[REDACTED_OPENROUTER_KEY]",
  opencode: "[REDACTED_OPENCODE_KEY]",
  github: "[REDACTED_GITHUB_TOKEN]",
  secret: "[REDACTED_SECRET]",
};

/** Longest prefix first: `sk-or-` must win over the generic `sk-` rule. */
const PATTERN_SPECS = [
  { label: LABELS.openrouter, source: String.raw`\bsk-or-[A-Za-z0-9_-]{8,}` },
  { label: LABELS.opencode, source: String.raw`\boc_sk_[A-Za-z0-9_-]{8,}` },
  { label: LABELS.github, source: String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}` },
  { label: LABELS.github, source: String.raw`\bghp_[A-Za-z0-9]{20,}` },
  { label: LABELS.secret, source: String.raw`\bsk-(?!or-)[A-Za-z0-9_-]{16,}` },
];

const SECRET_ENV_NAME = /_(KEY|TOKEN|SECRET|PASSWORD)$/i;
const MIN_SECRET_LENGTH = 8;
const LABEL_TEXT = Object.values(LABELS);

/** True when a value is part of a label, so replacing it cannot corrupt one. */
function isLabelFragment(value) {
  return LABEL_TEXT.some((label) => label.includes(value));
}

/** Walk up from `startDir` to the first directory with a `.git` entry. */
export function findRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}

/** Strip an `export ` prefix and keep only a valid shell name. */
function envName(rawName) {
  let name = rawName.trim();
  if (name.startsWith("export") && /\s/.test(name.charAt("export".length))) {
    name = name.slice("export".length).trim();
  }
  return /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
}

/** Trim a value and remove one matching pair of quotes. */
function envValue(rawValue) {
  const value = rawValue.trim();
  if (value.length < 2) return value;
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  return quoted ? value.slice(1, -1) : value;
}

function parseEnvLine(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return undefined;
  const equals = line.indexOf("=");
  if (equals <= 0) return undefined;
  const name = envName(line.slice(0, equals));
  if (!name) return undefined;
  return { name, value: envValue(line.slice(equals + 1)) };
}

/** Minimal dotenv reader. Values stay in memory; the caller never prints them. */
export function parseEnvFile(text) {
  const entries = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const entry = parseEnvLine(rawLine);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Exact values from `env` and parsed `.env` text, longest first. */
export function collectSecrets(env = {}, envText = "") {
  const values = new Set();
  const add = (name, value) => {
    if (!SECRET_ENV_NAME.test(name)) return;
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) return;
    if (isLabelFragment(value)) return;
    values.add(value);
  };
  for (const [name, value] of Object.entries(env)) add(name, value);
  for (const entry of parseEnvFile(envText)) add(entry.name, entry.value);
  return [...values].sort((left, right) => right.length - left.length);
}

function occurrences(text, value) {
  let count = 0;
  let index = text.indexOf(value);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(value, index + value.length);
  }
  return count;
}

/** True when a known pattern already covers the value. */
function hasPattern(value) {
  return PATTERN_SPECS.some((spec) => new RegExp(spec.source).test(value));
}

/** Replace exact values and known key shapes. Returns text, never a value. */
export function redactText(text, secrets = []) {
  let output = String(text ?? "");
  // Exact values first: a pattern inside an exact value must not leave a prefix.
  for (const value of secrets) {
    if (!value) continue;
    output = output.split(value).join(LABELS.secret);
  }
  for (const spec of PATTERN_SPECS) {
    output = output.replace(new RegExp(spec.source, "g"), spec.label);
  }
  return output;
}

/** Count matches without printing or returning a value. */
export function countSecrets(text, secrets = []) {
  const input = String(text ?? "");
  let count = 0;
  for (const spec of PATTERN_SPECS) {
    const matches = input.match(new RegExp(spec.source, "g"));
    if (matches) count += matches.length;
  }
  for (const value of secrets) {
    if (!value || hasPattern(value)) continue;
    count += occurrences(input, value);
  }
  return count;
}

/** Line-buffered redaction for a stream. Complete lines leave as soon as they arrive. */
export function createLineRedactor(redact) {
  let pending = "";
  return {
    push(chunk) {
      pending += String(chunk ?? "");
      let output = "";
      let index = pending.indexOf("\n");
      while (index >= 0) {
        output += redact(pending.slice(0, index + 1));
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
      }
      return output;
    },
    flush() {
      if (pending.length === 0) return "";
      const output = redact(pending);
      pending = "";
      return output;
    },
  };
}

/** Build once per process: env values plus the repo `.env`, if it exists. */
export function createRedactor(options = {}) {
  const root = options.root ?? findRepoRoot();
  let envText = "";
  try {
    const envFile = path.join(root, ".env");
    if (existsSync(envFile)) envText = readFileSync(envFile, "utf8");
  } catch {
    // A missing or unreadable .env only removes exact values; patterns still apply.
  }
  const secrets = collectSecrets(options.env ?? process.env, envText);
  return { secrets, redact: (text) => redactText(text, secrets) };
}

function usage() {
  return `Usage: node scripts/redact-log.mjs [--file <path>] [--in-place]

  stdin -> stdout by default. --file reads one file; --in-place writes the
  redacted text back. Exit 0 on success, 2 on a usage error.
`;
}

function fail(message) {
  process.stderr.write(`redact-log: ${message}\n\n${usage()}`);
  process.exitCode = 2;
}

async function main() {
  const args = process.argv.slice(2);
  const redactor = createRedactor();
  const fileIndex = args.indexOf("--file");
  const inPlace = args.includes("--in-place");
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  if (fileIndex >= 0) {
    const file = args[fileIndex + 1];
    if (!file || file.startsWith("--")) return fail("--file needs a path");
    if (!inPlace && args.length > fileIndex + 2) return fail(`unknown argument: ${args[fileIndex + 2]}`);
    const text = readFileSync(file, "utf8");
    const redacted = redactor.redact(text);
    if (inPlace) {
      writeFileSync(file, redacted);
      return;
    }
    process.stdout.write(redacted);
    return;
  }
  if (inPlace) return fail("--in-place needs --file");
  if (args.length > 0) return fail(`unknown argument: ${args[0]}`);

  const buffer = createLineRedactor(redactor.redact);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    const output = buffer.push(chunk);
    if (output) process.stdout.write(output);
  });
  process.stdin.on("end", () => {
    const tail = buffer.flush();
    if (tail) process.stdout.write(tail);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`redact-log: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
