#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the check summary and every error. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * Check the committed feature map.
 *
 * The map is an audit index, so a stale ref, an unknown status, or a `covered`
 * row without a committed test makes it lie. This checker validates the
 * structure and every reference. A ref is `path#anchor`: the anchor (a symbol,
 * command id, settings row name, or test title) must still be in that file. A
 * `path:line` ref is rejected: line numbers drift on every edit.
 *
 * It also takes an inventory of entry points (command ids, slash commands,
 * settings rows) and fails when one is not named in a row's first cell.
 *
 * It does not judge whether the cited test asserts the right behavior; the
 * reviewer and the witness gate own that.
 */

const FEATURES_DIR = path.join(".agents", "skills", "verify-obsidian-chat", "features");
const SECTIONS = [
  "## Sub-features",
  "## How to get to it (user view)",
  "## Driving it with the probe harness",
  "## Proof",
  "## Gotchas",
];
const STATUSES = new Set(["covered", "partial", "NONE", "unreachable"]);
/** A ref is `path#anchor`: the anchor is a symbol, id, row name, or test title in that file. */
const REF_PATTERN = /`([A-Za-z0-9_./-]+\.(?:ts|mts|mjs|json|md))#([^`]+)`/g;
/** The old `path:line` form drifted on every edit; the checker rejects it. */
const LINE_REF_PATTERN = /`([A-Za-z0-9_./-]+\.(?:ts|mts|mjs|json|md)):(\d+)`/g;
const COVERED_LIES = ["no committed check", "unit only", "policy only"];

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

function checkRef(root, ref, where, sourceCell) {
  const errors = [];
  const normalized = normalizedPath(ref.path);
  const label = `${ref.path}#${ref.anchor}`;
  if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    errors.push(`${where}: unsafe reference ${label}`);
    return errors;
  }
  const absolute = path.join(root, normalized);
  if (!isFile(absolute)) {
    errors.push(`${where}: missing file ${label}`);
    return errors;
  }
  if (!readFileSync(absolute, "utf8").includes(ref.anchor)) {
    errors.push(`${where}: anchor "${ref.anchor}" is not in ${ref.path}; point the ref at the symbol's new home`);
  }
  if (sourceCell && !normalized.startsWith("src/")) {
    errors.push(`${where}: source must point under src/, got ${label}`);
  }
  return errors;
}

function refsIn(cell) {
  const refs = [];
  for (const match of cell.matchAll(REF_PATTERN)) {
    refs.push({ path: match[1], anchor: match[2].trim(), raw: match[0] });
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
  return cell.replace(REF_PATTERN, " ").replace(LINE_REF_PATTERN, " ").replace(/[;,\s]+/g, " ").trim();
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

/** Every old-form `path:line` ref in the map, including prose and README: each one is an error. */
function checkLineRefs(root, files, errors) {
  for (const file of [...files, "README.md"]) {
    const absolute = path.join(root, FEATURES_DIR, file);
    if (!isFile(absolute)) continue;
    const lines = readFileSync(absolute, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(LINE_REF_PATTERN)) {
        errors.push(`${file}:${index + 1}: ${match[0]} uses a line number; write \`${match[1]}#<symbol>\` instead`);
      }
    });
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

function importsSettingsRow(text) {
  const match = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']*settings-definition-kit["']/s.exec(text);
  if (!match) return false;
  return match[1].split(",").some((item) => item.trim().split(/\s+as\s+/)[0] === "row");
}

function settingsEntryPoints(root) {
  const entries = [];
  for (const absolute of walkFiles(path.join(root, "src"))) {
    if (!absolute.endsWith(".ts")) continue;
    const text = readFileSync(absolute, "utf8");
    if (!importsSettingsRow(text)) continue;
    const file = normalizedPath(path.relative(root, absolute));
    for (const match of text.matchAll(/\brow\(\s*"([^"]*)"/g)) {
      if (!match[1]) continue;
      entries.push({
        kind: "settings row",
        name: match[1],
        file,
        line: lineNumberAt(text, match.index),
      });
    }
  }
  return entries;
}

export function entryPoints(root) {
  return [...commandEntryPoints(root), ...slashEntryPoints(root), ...settingsEntryPoints(root)];
}

function normalizedWords(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Match the entry name against the row's first cell only. A match starts at a
 * word boundary at the start of the cell or of one `:`/`>` segment, so
 * `row("Name")` does not pass on "`/agent <name> <task>`" and `row("Import")`
 * does not pass on "Imported MCP servers start disabled".
 */
function namesEntryPoint(cell, name) {
  const needle = normalizedWords(name);
  if (needle.length === 0) return false;
  for (const part of cell.split(/[:>]/)) {
    const words = normalizedWords(part);
    if (needle.every((word, index) => words[index] === word)) return true;
  }
  return false;
}

function checkInventory(root, rows, errors) {
  const entryCells = rows.map((row) => row.cells[0] ?? "");
  const reported = new Set();
  for (const entry of entryPoints(root)) {
    const key = `${entry.kind}:${entry.name}`;
    if (INVENTORY_ALLOWLIST.has(key) || reported.has(key)) continue;
    if (entryCells.some((cell) => namesEntryPoint(cell, entry.name))) continue;
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
  if (sourceRefs.length === 0) errors.push(`${where}: source needs a path#anchor reference`);
  for (const ref of sourceRefs) errors.push(...checkRef(root, ref, where, true));

  const proofRefs = refsIn(proof);
  for (const ref of proofRefs) errors.push(...checkRef(root, ref, where, false));
  for (const ref of proofRefs) {
    if (!ref.path.startsWith("test/") && status !== "unreachable") {
      errors.push(`${where}: proof must point under test/, got ${ref.path}#${ref.anchor}`);
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
  checkLineRefs(root, files, errors);
  checkInventory(root, allRows, errors);
  return { ok: errors.length === 0, errors, journeys: files.length, rows, refs };
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
  const result = checkFeatureMap(process.cwd());
  reportCheck(result);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
