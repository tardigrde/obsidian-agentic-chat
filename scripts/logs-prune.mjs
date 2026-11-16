#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints what it removes. */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * `npm run logs:prune`: keep logs/ small enough that the secret scan stays
 * fast and agents do not read stale evidence. Dry run by default; `--apply`
 * deletes. It never touches anything outside logs/, and never logs/history.jsonl.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rules, applied to direct children of each directory under logs/. */
export const DEFAULT_RULES = [
  { dir: "verify", keepNewest: 100 },
  { dir: "e2e-artifacts", keepNewest: 50 },
  { dir: "eval-runs", keepNewest: 100 },
  { dir: "witness", keepNewest: 50 },
  { dir: "dogfood-runs", keepNewest: 50 },
  { dir: "chaos", maxAgeDays: 30 },
  { dir: "probes", maxAgeDays: 30 },
  { dir: "design-audit", removeAll: true },
  { dir: "clip-debug", removeAll: true },
];

/** Never removed, whatever the rules say. */
const PROTECTED = new Set(["history.jsonl"]);

function entries(dir) {
  try {
    return readdirSync(dir).map((name) => {
      const full = path.join(dir, name);
      const stats = statSync(full);
      return { name, full, mtimeMs: stats.mtimeMs, size: sizeOf(full, stats) };
    });
  } catch {
    return [];
  }
}

function sizeOf(full, stats = statSync(full)) {
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const name of readdirSync(full)) {
    try {
      total += sizeOf(path.join(full, name));
    } catch {
      // A file removed mid-walk does not count.
    }
  }
  return total;
}

/** Stale bundle copies (main.js) anywhere under logs/, outside kept run dirs' newest entries. */
function staleBundles(logsDir) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const entry of entries(dir)) {
      let isDir;
      try {
        isDir = statSync(entry.full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(entry.full, depth + 1);
      else if (entry.name === "main.js") out.push(entry);
    }
  };
  walk(logsDir, 0);
  return out;
}

export function planPrune(root, { now = Date.now(), rules = DEFAULT_RULES } = {}) {
  const logsDir = path.join(root, "logs");
  const remove = [];
  if (!existsSync(logsDir)) return remove;
  for (const rule of rules) {
    const dir = path.join(logsDir, rule.dir);
    if (!existsSync(dir)) continue;
    if (rule.removeAll) {
      remove.push({ path: dir, reason: `${rule.dir}/ is retired`, size: sizeOf(dir) });
      continue;
    }
    const children = entries(dir)
      .filter((entry) => !PROTECTED.has(entry.name))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    children.forEach((entry, index) => {
      if (rule.keepNewest !== undefined && index >= rule.keepNewest) {
        remove.push({ path: entry.full, reason: `older than the newest ${rule.keepNewest} in ${rule.dir}/`, size: entry.size });
      } else if (rule.maxAgeDays !== undefined && now - entry.mtimeMs > rule.maxAgeDays * DAY_MS) {
        remove.push({ path: entry.full, reason: `older than ${rule.maxAgeDays} days`, size: entry.size });
      }
    });
  }
  // Defense in depth: every target must sit strictly inside logs/.
  const inside = (entry) => {
    const relative = path.relative(logsDir, entry.path);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) && !PROTECTED.has(relative);
  };
  const safe = remove.filter(inside);
  const covered = (file) => safe.some((entry) => file === entry.path || file.startsWith(`${entry.path}${path.sep}`));
  for (const bundle of staleBundles(logsDir)) {
    if (!covered(bundle.full)) safe.push({ path: bundle.full, reason: "stale main.js copy", size: bundle.size });
  }
  return safe;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: npm run logs:prune [-- --apply]\n\n" +
        "Dry run by default. Keeps the newest 100 verify runs, 50 e2e-artifact dirs, 100 eval runs,\n" +
        "50 witness and dogfood runs, 30 days of chaos and probe media; removes logs/design-audit,\n" +
        "logs/clip-debug, and stale main.js copies. Never touches anything outside logs/.",
    );
    return;
  }
  const apply = process.argv.includes("--apply");
  const plan = planPrune(process.cwd());
  const total = plan.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of plan) {
    console.log(`${apply ? "remove" : "would remove"}  ${path.relative(process.cwd(), entry.path)}  (${formatBytes(entry.size)}; ${entry.reason})`);
    if (apply) rmSync(entry.path, { recursive: true, force: true });
  }
  console.log(
    `logs:prune: ${plan.length} path(s), ${formatBytes(total)} ${apply ? "freed" : "would be freed; pass --apply to delete"}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
