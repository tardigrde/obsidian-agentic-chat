#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the check summary and every error. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * Check the committed feature map.
 *
 * The map is an audit index, so a stale `path:line`, an unknown status, or a
 * `covered` row without a committed test makes it lie. This checker validates
 * the structure and every reference. It does not judge whether the cited test
 * asserts the right behavior; the reviewer and the witness gate own that.
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
const REF_PATTERN = /`([A-Za-z0-9_./-]+\.(?:ts|mts|mjs|json|md)):(\d+)`/g;
const COVERED_LIES = ["no committed check", "unit only", "policy only"];

function isFile(file) {
  return existsSync(file) && statSync(file).isFile();
}

function checkRef(root, ref, where, sourceCell) {
  const errors = [];
  const normalized = ref.path.replaceAll("\\", "/");
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
 * test. E2E, probe, dogfood, and replay harness tests qualify. A plain vitest
 * file that imports the subject directly is `partial`.
 */
function isUserActionProof(root, ref) {
  const file = ref.path.replaceAll("\\", "/");
  if (!/\.(?:test|e2e|dogfood)\.ts$/.test(file)) return false;
  if (file.startsWith("test/e2e/")) return true;
  if (file.startsWith("test/live/")) return false;
  const absolute = path.join(root, file);
  if (!isFile(absolute)) return false;
  return /\b(?:runAgentReplay|helpers\/agent-replay)\b/.test(readFileSync(absolute, "utf8"));
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
        `${where}: covered needs an e2e, probe, dogfood, or replay reference, not a unit-only test`,
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

function checkReadme(root, journeyFiles) {
  const errors = [];
  const absolute = path.join(root, FEATURES_DIR, "README.md");
  if (!isFile(absolute)) return [`README.md is missing`];
  const text = readFileSync(absolute, "utf8");
  const links = new Set();
  for (const match of text.matchAll(/\]\(\.\/([A-Za-z0-9_.-]+\.md)\)/g)) links.add(match[1]);
  for (const file of journeyFiles) {
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
  const journeyFiles = readdirSync(directory)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort();
  const errors = checkReadme(root, journeyFiles);
  let rows = 0;
  let refs = 0;
  for (const file of journeyFiles) {
    const result = checkJourney(root, file);
    errors.push(...result.errors);
    rows += result.rows.length;
    refs += result.rows.reduce(
      (total, row) => total + refsIn(row.cells[1]).length + refsIn(row.cells[2]).length,
      0,
    );
  }
  return { ok: errors.length === 0, errors, journeys: journeyFiles.length, rows, refs };
}

function main() {
  const result = checkFeatureMap(process.cwd());
  if (result.ok) {
    console.log(
      `feature map: PASS (${result.journeys} journeys, ${result.rows} rows, ${result.refs} refs)`,
    );
    return;
  }
  console.error(`feature map: FAIL (${result.errors.length} errors)`);
  for (const error of result.errors) console.error(`  ${error}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
