#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the decision and the witness output. */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Run the witness declared in a pull request body.
 *
 * The body is untrusted input, so the parser accepts a test file and source
 * paths, never a shell command. CI supplies the base commit and the changed
 * files, so a PR cannot choose its own comparison point or hide a source change.
 */

const BLOCK_PATTERN = /<!--\s*witness\b([\s\S]*?)-->|```witness[ \t]*\r?\n([\s\S]*?)```/gi;
const BEHAVIOR_LABELS = new Set(["behavior", "witness"]);
const OPT_OUT_LABEL = "no-behavior-change";

export function extractWitnessBlocks(body) {
  return [...String(body ?? "").matchAll(BLOCK_PATTERN)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
}

export function extractWitnessBlock(body) {
  const blocks = extractWitnessBlocks(body);
  return (
    blocks.find((block) => {
      const spec = parseWitnessBlock(block);
      return spec.testFile || spec.sources.length > 0 || spec.errors.length > 0;
    }) ??
    blocks[0] ??
    null
  );
}

export function parseWitnessBlock(block) {
  const spec = { testFile: null, sources: [], errors: [] };
  for (const rawLine of String(block ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 0) {
      spec.errors.push(`expected "key: value", got "${line}"`);
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^`|`$/g, "");
    switch (key) {
      case "test":
      case "test-file":
        if (spec.testFile && spec.testFile !== value) {
          spec.errors.push("name exactly one test file");
        }
        spec.testFile = value;
        break;
      case "src":
      case "source":
        spec.sources.push(value);
        break;
      case "base":
        // CI supplies the base so the PR cannot widen or narrow its own diff.
        break;
      default:
        spec.errors.push(`unknown key "${key}"`);
    }
  }
  return spec;
}

function isRepoFile(root, value, directory) {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return false;
  if (!normalized.startsWith(`${directory}/`)) return false;
  const absolute = path.resolve(root, normalized);
  return existsSync(absolute) && statSync(absolute).isFile();
}

export function validateWitnessSpec(spec, root = process.cwd()) {
  const errors = [...spec.errors];
  if (!spec.testFile) {
    errors.push("add one `test: test/...test.ts` line");
  } else if (!isRepoFile(root, spec.testFile, "test")) {
    errors.push(`test file is missing or outside test/: ${spec.testFile}`);
  } else if (!spec.testFile.endsWith(".ts")) {
    errors.push(`test file must be TypeScript: ${spec.testFile}`);
  }
  if (spec.sources.length === 0) {
    errors.push("add at least one `src: src/...ts` line");
  }
  for (const source of spec.sources) {
    if (!isRepoFile(root, source, "src")) {
      errors.push(`source file is missing or outside src/: ${source}`);
    } else if (!source.endsWith(".ts")) {
      errors.push(`source file must be TypeScript: ${source}`);
    }
  }
  return [...new Set(errors)];
}

function filledSpecs(body) {
  return extractWitnessBlocks(body)
    .map(parseWitnessBlock)
    .filter((spec) => spec.testFile || spec.sources.length > 0 || spec.errors.length > 0);
}

function specSignature(spec) {
  return JSON.stringify({ testFile: spec.testFile, sources: [...spec.sources].sort() });
}

export function witnessDecision({ body, labels = [], root = process.cwd(), changedFiles = [] }) {
  const normalizedLabels = labels.map((label) => label.trim().toLowerCase()).filter(Boolean);
  const requiresWitness = normalizedLabels.some((label) => BEHAVIOR_LABELS.has(label));
  const optedOut = normalizedLabels.includes(OPT_OUT_LABEL);
  const changedSources = changedFiles
    .map((file) => String(file).replaceAll("\\", "/"))
    .filter((file) => file.startsWith("src/") && file.endsWith(".ts"));

  const specs = filledSpecs(body);
  const distinct = new Set(specs.map(specSignature));
  if (distinct.size > 1) {
    return {
      action: "fail",
      reason: "keep one witness block; this PR has several different blocks",
    };
  }
  const spec = specs[0] ?? null;

  if (!spec) {
    if (requiresWitness) {
      return {
        action: "fail",
        reason:
          "this PR has the behavior or witness label, so it needs a witness block in its body",
      };
    }
    if (changedSources.length > 0 && !optedOut) {
      return {
        action: "fail",
        reason: `this PR changes ${changedSources[0]} plus ${Math.max(0, changedSources.length - 1)} other source file(s), so it needs a witness block or the ${OPT_OUT_LABEL} label`,
      };
    }
    return {
      action: "skip",
      reason:
        changedSources.length > 0
          ? `the ${OPT_OUT_LABEL} label claims no behavior change`
          : "no source change and no witness block",
    };
  }

  const errors = validateWitnessSpec(spec, root);
  if (errors.length > 0) return { action: "fail", reason: errors.join("; "), spec };
  return { action: "run", spec };
}

function changedFiles(base, cwd) {
  const result = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function fail(message) {
  console.error(`witness: invalid PR evidence (${message})`);
  console.error(
    [
      "",
      "Add this block to the PR body:",
      "<!-- witness",
      "test: test/example.test.ts",
      "src: src/example.ts",
      "-->",
      "",
      `A pure refactor that changes src/ can use the "${OPT_OUT_LABEL}" label instead.`,
    ].join("\n"),
  );
  process.exitCode = 1;
}

function main() {
  const labels = String(process.env.PR_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  const base = process.env.BASE_SHA;
  const cwd = process.cwd();
  if (!base) {
    fail("BASE_SHA is missing; the workflow must supply the pull request base.");
    return;
  }
  const files = changedFiles(base, cwd);
  if (files === null) {
    fail(`could not diff ${base}...HEAD; the checkout must include the base commit.`);
    return;
  }
  const decision = witnessDecision({
    body: process.env.PR_BODY ?? "",
    labels,
    root: cwd,
    changedFiles: files,
  });

  if (decision.action === "skip") {
    console.log(`witness: skipped (${decision.reason})`);
    return;
  }
  if (decision.action === "fail") {
    fail(decision.reason);
    return;
  }

  const args = [
    path.resolve("scripts/verify-witness.mjs"),
    "--base",
    base,
    "--test-file",
    decision.spec.testFile,
    ...decision.spec.sources.flatMap((source) => ["--src", source]),
    "--report-dir",
    path.resolve("logs/witness/ci"),
  ];
  console.log(`witness: ${decision.spec.testFile} against ${base}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
