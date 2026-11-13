#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the check summary and every error. */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * Check the committed feature map.
 *
 * The map is an audit index, so a stale `path:line`, an unknown status, or a
 * `covered` row without a committed test makes it lie. This checker validates
 * the structure and every reference. It also pins the trimmed text of every
 * referenced line in `refs.lock.json`: a ref that drifts to another non-blank
 * line fails instead of passing silently. `--fix` moves a drifted ref back to
 * its locked text; `--write-lock` adopts the current lines.
 *
 * It does not judge whether the cited test asserts the right behavior; the
 * reviewer and the witness gate own that.
 */

const FEATURES_DIR = path.join(".agents", "skills", "verify-obsidian-chat", "features");
const LOCK_FILE = path.join(FEATURES_DIR, "refs.lock.json");
const SECTIONS = [
  "## Sub-features",
  "## How to get to it (user view)",
  "## Driving it with the probe harness",
  "## Proof",
  "## Gotchas",
];
const STATUSES = new Set(["covered", "partial", "NONE", "unreachable"]);
const REF_PATTERN = /`([A-Za-z0-9_./-]+\.(?:ts|mts|mjs|json|md)):(\d+)`/g;
const COVERED_LIES = ["no committed check", "unit only", "policy only"];
const LOCK_HINT = "run npm run fix:feature-map -- --write-lock";
const FIX_HINT = "run npm run fix:feature-map";

/**
 * Entry points that must not appear in the map. Keep this empty unless there is
 * a real reason; every row added here hides a user-reachable control.
 */
const INVENTORY_ALLOWLIST = new Map([
  // Example: ["row:internal-only", "rendered by a unit fixture, not a settings row"],
]);

function isFile(file) {
  return existsSync(file) && statSync(file).isFile();
}

function normalizedPath(file) {
  return file.replaceAll("\\", "/");
}

function refKey(ref) {
  return `${normalizedPath(ref.path)}:${ref.line}`;
}

function lineText(root, refPath, line) {
  const absolute = path.join(root, normalizedPath(refPath));
  if (!isFile(absolute)) return undefined;
  const lines = readFileSync(absolute, "utf8").split("\n");
  if (line < 1 || line > lines.length) return undefined;
  return lines[line - 1].trim();
}

function checkRef(root, ref, where, sourceCell) {
  const errors = [];
  const normalized = normalizedPath(ref.path);
  if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    errors.push(`${where}: unsafe reference ${ref.path}:${ref.line}`);
    return errors;
  }
  const absolute = path.join(root, normalized);
  if (!isFile(absolute)) {
    errors.push(`${where}: missing file ${ref.path}:${ref.line}`);
    return errors;
  }
  const lines = readFileSync(absolute, "utf8").split("\n");
  if (ref.line < 1 || ref.line > lines.length) {
    errors.push(`${where}: ${ref.path}:${ref.line} is outside the file (1-${lines.length})`);
    return errors;
  }
  if (!lines[ref.line - 1].trim()) {
    errors.push(`${where}: ${ref.path}:${ref.line} points at a blank line`);
  }
  if (sourceCell && !normalized.startsWith("src/")) {
    errors.push(`${where}: source must point under src/, got ${ref.path}:${ref.line}`);
  }
  return errors;
}

function refsIn(cell) {
  const refs = [];
  for (const match of cell.matchAll(REF_PATTERN)) {
    refs.push({ path: match[1], line: Number(match[2]), raw: match[0] });
  }
  return refs;
}

/**
 * A `covered` row needs a check that drives the user action, not only a unit
 * test. A deterministic e2e or probe scenario qualifies, and so does a replay
 * that imports the replay harness. A live spec (which skips without keys), a
 * dogfood spec (which needs a generated vault), a helper, and a plain vitest
 * file do not.
 */
const REPLAY_IMPORT =
  /^import\s+(?!type\b)\{[^}]*\brunAgentReplay\b[^}]*\}\s+from\s+["'][^"']*helpers\/agent-replay["']/m;

function isUserActionProof(root, ref) {
  const file = normalizedPath(ref.path);
  if (!/\.(?:test|e2e|dogfood)\.ts$/.test(file)) return false;
  if (file.startsWith("test/e2e/")) {
    const base = file.split("/").pop() ?? "";
    if (file.startsWith("test/e2e/dogfood/")) return false;
    if (base.includes("-live.") || base.startsWith("live-")) return false;
    return true;
  }
  if (file.startsWith("test/live/")) return false;
  const absolute = path.join(root, file);
  if (!isFile(absolute)) return false;
  const text = readFileSync(absolute, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return REPLAY_IMPORT.test(text);
}

function stripRefs(cell) {
  return cell.replace(REF_PATTERN, " ").replace(/[;,\s]+/g, " ").trim();
}

function parseProofRows(lines, file) {
  const rows = [];
  const start = lines.findIndex((line) => line.trim() === "## Proof");
  if (start < 0) return rows;
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("|")) continue;
    if (/^\|[\s:|-]+\|$/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells[0].toLowerCase() === "entry point") continue;
    rows.push({ line: index + 1, text: line, cells, file });
  }
  return rows;
}

function journeyFiles(root) {
  const directory = path.join(root, FEATURES_DIR);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return null;
  return readdirSync(directory)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort();
}

/** Every backticked `path:line` in the map, including prose sections and README. */
function collectMapRefs(root, files) {
  const refs = [];
  const mapFiles = [...files, "README.md"];
  for (const file of mapFiles) {
    const absolute = path.join(root, FEATURES_DIR, file);
    if (!isFile(absolute)) continue;
    const lines = readFileSync(absolute, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      for (const ref of refsIn(lines[index])) {
        refs.push({ ...ref, mapFile: file, mapLine: index + 1 });
      }
    }
  }
  return refs;
}

function lockKeySet(refs) {
  const unique = new Map();
  for (const ref of refs) {
    const key = refKey(ref);
    if (!unique.has(key)) unique.set(key, ref);
  }
  return unique;
}

export function readLock(root) {
  const absolute = path.join(root, LOCK_FILE);
  if (!isFile(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8"));
}

function writeLockObject(root, lock) {
  const sorted = {};
  for (const key of Object.keys(lock).sort()) sorted[key] = lock[key];
  writeFileSync(path.join(root, LOCK_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
  return sorted;
}

/** Pin the trimmed text of every referenced line. */
export function writeLock(root) {
  const files = journeyFiles(root) ?? [];
  const lock = {};
  let skipped = 0;
  for (const [key, ref] of lockKeySet(collectMapRefs(root, files))) {
    const text = lineText(root, ref.path, ref.line);
    if (text === undefined) {
      skipped += 1;
      continue;
    }
    lock[key] = text;
  }
  writeLockObject(root, lock);
  return { count: Object.keys(lock).length, skipped };
}

function checkLock(root, files, errors) {
  const lock = readLock(root);
  if (!lock) {
    errors.push(`${LOCK_FILE} is missing (${LOCK_HINT})`);
    return;
  }
  const seen = new Set();
  for (const ref of collectMapRefs(root, files)) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const where = `${ref.mapFile}:${ref.mapLine}`;
    const expected = lock[key];
    if (expected === undefined) {
      errors.push(`${where}: ${key} has no lock entry (${LOCK_HINT})`);
      continue;
    }
    const actual = lineText(root, ref.path, ref.line);
    if (actual === undefined) {
      errors.push(`${where}: ${key} is missing or outside the file (${LOCK_HINT})`);
      continue;
    }
    if (actual !== expected) {
      errors.push(
        `${where}: ${key} text changed: expected "${expected}", found "${actual}" (${FIX_HINT})`,
      );
    }
  }
}

function walkFiles(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function commandEntryPoints(root) {
  const entries = [];
  for (const absolute of walkFiles(path.join(root, "src"))) {
    if (!absolute.endsWith(".ts")) continue;
    const text = readFileSync(absolute, "utf8");
    const file = normalizedPath(path.relative(root, absolute));
    for (const match of text.matchAll(/addCommand\s*\(\s*\{[\s\S]*?\bid:\s*"([^"]+)"/g)) {
      entries.push({
        kind: "command id",
        name: match[1],
        file,
        line: lineNumberAt(text, match.index),
      });
    }
  }
  return entries;
}

function slashEntryPoints(root) {
  const entries = [];
  const absolute = path.join(root, "src", "ui", "commands.ts");
  if (!isFile(absolute)) return entries;
  const text = readFileSync(absolute, "utf8");
  const start = text.indexOf("SLASH_COMMANDS = [");
  if (start < 0) return entries;
  const close = text.indexOf("] as const", start);
  const body = text.slice(start, close < 0 ? undefined : close);
  for (const match of body.matchAll(/\bname:\s*"([^"]+)"/g)) {
    entries.push({
      kind: "slash command",
      name: `/${match[1]}`,
      file: "src/ui/commands.ts",
      line: lineNumberAt(text, start + match.index),
    });
  }
  return entries;
}

function settingsEntryPoints(root) {
  const entries = [];
  const directory = path.join(root, "src");
  if (!existsSync(directory)) return entries;
  const files = readdirSync(directory)
    .filter((file) => /^settings.*\.ts$/.test(file))
    .sort();
  for (const file of files) {
    const absolute = path.join(directory, file);
    if (!isFile(absolute)) continue;
    const text = readFileSync(absolute, "utf8");
    for (const match of text.matchAll(/\brow\(\s*"([^"]*)"/g)) {
      if (!match[1]) continue;
      entries.push({
        kind: "settings row",
        name: match[1],
        file: `src/${file}`,
        line: lineNumberAt(text, match.index),
      });
    }
  }
  return entries;
}

export function entryPoints(root) {
  return [...commandEntryPoints(root), ...slashEntryPoints(root), ...settingsEntryPoints(root)];
}

function normalizeEntry(text) {
  return text
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function checkInventory(root, rows, errors) {
  const entryCells = rows.map((row) => normalizeEntry(row.cells[0] ?? ""));
  const reported = new Set();
  for (const entry of entryPoints(root)) {
    const key = `${entry.kind}:${entry.name}`;
    if (INVENTORY_ALLOWLIST.has(key) || reported.has(key)) continue;
    const needle = normalizeEntry(entry.name);
    if (entryCells.some((cell) => cell.includes(needle))) continue;
    reported.add(key);
    errors.push(
      `${entry.file}:${entry.line}: ${entry.kind} "${entry.name}" is not named in any feature map row`,
    );
  }
}

function checkRow(root, row) {
  const errors = [];
  const where = `${row.file}:${row.line}`;
  if (row.cells.length !== 4) {
    errors.push(`${where}: proof row needs 4 cells, got ${row.cells.length}`);
    return errors;
  }
  const [entry, source, proof, statusCell] = row.cells;
  if (!entry) errors.push(`${where}: entry point is empty`);
  const statusMatch = /^`([^`]+)`$/.exec(statusCell);
  if (!statusMatch) {
    errors.push(`${where}: status must be one backticked value, got "${statusCell}"`);
    return errors;
  }
  const status = statusMatch[1];
  if (!STATUSES.has(status)) {
    errors.push(`${where}: unknown status "${status}"`);
    return errors;
  }

  const sourceRefs = refsIn(source);
  if (sourceRefs.length === 0) errors.push(`${where}: source needs a path:line reference`);
  for (const ref of sourceRefs) errors.push(...checkRef(root, ref, where, true));

  const proofRefs = refsIn(proof);
  for (const ref of proofRefs) errors.push(...checkRef(root, ref, where, false));
  for (const ref of proofRefs) {
    if (!ref.path.startsWith("test/") && status !== "unreachable") {
      errors.push(`${where}: proof must point under test/, got ${ref.path}:${ref.line}`);
    }
  }

  const proofText = stripRefs(proof).toLowerCase();
  if (!proof.trim()) errors.push(`${where}: proof is empty`);
  if (status === "covered") {
    if (proofRefs.length === 0) {
      errors.push(`${where}: covered needs a committed test reference`);
    }
    if (!proofRefs.some((ref) => isUserActionProof(root, ref))) {
      errors.push(
        `${where}: covered needs a deterministic e2e, probe, or replay reference, not a unit-only test`,
      );
    }
    for (const lie of COVERED_LIES) {
      if (proofText.includes(lie)) {
        errors.push(`${where}: covered proof says "${lie}"`);
      }
    }
  }
  if (status === "NONE" && proofRefs.length > 0) {
    errors.push(`${where}: NONE must not cite a proof reference`);
  }
  return errors;
}

function checkJourney(root, file) {
  const absolute = path.join(root, FEATURES_DIR, file);
  const lines = readFileSync(absolute, "utf8").split("\n");
  const errors = [];
  let cursor = -1;
  for (const section of SECTIONS) {
    const index = lines.findIndex((line) => line.trim() === section);
    if (index < 0) {
      errors.push(`${file}: missing section "${section}"`);
      continue;
    }
    if (index < cursor) errors.push(`${file}: section "${section}" is out of order`);
    cursor = index;
  }
  const rows = parseProofRows(lines, file);
  if (rows.length === 0) errors.push(`${file}: no proof rows`);
  for (const row of rows) errors.push(...checkRow(root, row));
  return { errors, rows };
}

function checkReadme(root, journeyFileList) {
  const errors = [];
  const absolute = path.join(root, FEATURES_DIR, "README.md");
  if (!isFile(absolute)) return [`README.md is missing`];
  const text = readFileSync(absolute, "utf8");
  const links = new Set();
  for (const match of text.matchAll(/\]\(\.\/([A-Za-z0-9_.-]+\.md)\)/g)) links.add(match[1]);
  for (const file of journeyFileList) {
    if (!links.has(file)) errors.push(`README.md: journey "${file}" is not linked`);
  }
  for (const link of links) {
    if (!isFile(path.join(root, FEATURES_DIR, link))) {
      errors.push(`README.md: link target is missing: ${link}`);
    }
  }
  return errors;
}

export function checkFeatureMap(root = process.cwd()) {
  const directory = path.join(root, FEATURES_DIR);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return { ok: false, errors: [`feature map directory is missing: ${FEATURES_DIR}`], journeys: 0, rows: 0, refs: 0 };
  }
  const files = journeyFiles(root);
  const errors = checkReadme(root, files);
  const allRows = [];
  let rows = 0;
  let refs = 0;
  for (const file of files) {
    const result = checkJourney(root, file);
    errors.push(...result.errors);
    allRows.push(...result.rows);
    rows += result.rows.length;
    refs += result.rows.reduce(
      (total, row) => total + refsIn(row.cells[1]).length + refsIn(row.cells[2]).length,
      0,
    );
  }
  checkLock(root, files, errors);
  checkInventory(root, allRows, errors);
  return { ok: errors.length === 0, errors, journeys: files.length, rows, refs };
}

function nearestMatch(lines, expected, oldLine) {
  let best;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== expected) continue;
    const distance = Math.abs(index + 1 - oldLine);
    if (!best || distance < best.distance) best = { line: index + 1, distance };
  }
  return best?.line;
}

function searchOtherFiles(root, expected, currentFile) {
  const matches = [];
  for (const directory of ["src", "test"]) {
    for (const absolute of walkFiles(path.join(root, directory))) {
      if (!absolute.endsWith(".ts")) continue;
      const file = normalizedPath(path.relative(root, absolute));
      if (file === currentFile) continue;
      const lines = readFileSync(absolute, "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].trim() === expected) matches.push({ file, line: index + 1 });
      }
    }
  }
  return matches;
}

/**
 * Move every drifted ref back to its locked text: same file first (nearest
 * match), then a unique match under `src/` or `test/`. A ref whose text still
 * matches is never touched. Refs that cannot be placed stay in the map and
 * keep failing the check.
 */
export function fixFeatureMap(root = process.cwd()) {
  const files = journeyFiles(root) ?? [];
  const lock = readLock(root);
  if (!lock) {
    writeLock(root);
    return { moved: [], unplaced: [], wroteLock: true };
  }

  const moved = [];
  const unplaced = [];
  const keyMap = new Map();
  const cache = new Map();

  for (const [key, ref] of lockKeySet(collectMapRefs(root, files))) {
    const expected = lock[key];
    if (expected === undefined) {
      unplaced.push({ ref: key, reason: "no lock entry" });
      continue;
    }
    const actual = lineText(root, ref.path, ref.line);
    if (actual === expected) continue;
    if (actual === undefined) {
      unplaced.push({ ref: key, reason: "referenced line is missing" });
      continue;
    }

    const file = normalizedPath(ref.path);
    if (!cache.has(file)) {
      cache.set(file, readFileSync(path.join(root, file), "utf8").split("\n"));
    }
    let targetLine = nearestMatch(cache.get(file), expected, ref.line);
    let targetFile = file;
    if (targetLine === undefined) {
      const matches = searchOtherFiles(root, expected, file);
      if (matches.length === 1) {
        targetFile = matches[0].file;
        targetLine = matches[0].line;
      } else {
        const reason =
          matches.length === 0
            ? "text not found in the same file, src/, or test/"
            : `text is ambiguous in src/ and test/ (${matches.length} matches)`;
        unplaced.push({ ref: key, reason });
        continue;
      }
    }

    const to = `${targetFile}:${targetLine}`;
    keyMap.set(key, to);
    moved.push({ from: key, to });
  }

  for (const mapFile of [...files, "README.md"]) {
    const absolute = path.join(root, FEATURES_DIR, mapFile);
    if (!isFile(absolute)) continue;
    const text = readFileSync(absolute, "utf8");
    const rewritten = text.replace(REF_PATTERN, (match, refPath, line) => {
      const target = keyMap.get(`${normalizedPath(refPath)}:${line}`);
      return target ? `\`${target}\`` : match;
    });
    if (rewritten !== text) writeFileSync(absolute, rewritten);
  }

  if (moved.length > 0) {
    const rewrittenLock = {};
    for (const key of Object.keys(lock)) {
      const target = keyMap.get(key) ?? key;
      rewrittenLock[target] = lock[key];
    }
    writeLockObject(root, rewrittenLock);
  }

  return { moved, unplaced, wroteLock: false };
}

function reportCheck(result) {
  if (result.ok) {
    console.log(
      `feature map: PASS (${result.journeys} journeys, ${result.rows} rows, ${result.refs} refs)`,
    );
    return;
  }
  console.error(`feature map: FAIL (${result.errors.length} errors)`);
  for (const error of result.errors) console.error(`  ${error}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--write-lock")) {
    const result = writeLock(process.cwd());
    console.log(
      `feature map: wrote ${result.count} refs to ${LOCK_FILE}` +
        (result.skipped > 0 ? `, skipped ${result.skipped} unresolvable refs` : ""),
    );
    return;
  }
  if (args.includes("--fix")) {
    const result = fixFeatureMap(process.cwd());
    if (result.wroteLock) console.log(`feature map: no lock file; wrote ${LOCK_FILE}`);
    for (const move of result.moved) console.log(`moved ${move.from} -> ${move.to}`);
    for (const entry of result.unplaced) console.error(`unplaced ${entry.ref}: ${entry.reason}`);
    const check = checkFeatureMap(process.cwd());
    reportCheck(check);
    process.exitCode = check.ok ? 0 : 1;
    return;
  }
  const result = checkFeatureMap(process.cwd());
  reportCheck(result);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
