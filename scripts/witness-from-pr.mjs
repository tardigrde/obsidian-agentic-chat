#!/usr/bin/env node
/* eslint-disable no-console -- CLI prints the decision and the witness output. */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const WITNESS_KINDS = new Set(["test", "removal"]);
/** A witness may revert production code (`src/`) or tooling (`scripts/`). */
const SOURCE_DIRECTORIES = ["src", "scripts"];

export function extractWitnessBlocks(body) {
  return [...String(body ?? "").matchAll(BLOCK_PATTERN)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
}

export function extractWitnessBlock(body) {
  const blocks = extractWitnessBlocks(body);
  return (
    blocks.find((block) => isFilled(parseWitnessBlock(block))) ??
    blocks[0] ??
    null
  );
}

export function parseWitnessBlock(block) {
  const spec = { kind: "test", testFile: null, sources: [], gone: [], absent: [], errors: [] };
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
      case "kind":
        if (!WITNESS_KINDS.has(value.toLowerCase())) {
          spec.errors.push(`kind must be "test" or "removal", got "${value}"`);
        } else {
          spec.kind = value.toLowerCase();
        }
        break;
      case "gone":
        spec.gone.push(value);
        break;
      case "absent":
        if (value) spec.absent.push(value);
        else spec.errors.push("an `absent:` line needs the text that must be gone");
        break;
      default:
        spec.errors.push(`unknown key "${key}"`);
    }
  }
  return spec;
}

function normalizeRepoPath(value) {
  if (!value || path.isAbsolute(value)) return null;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

function isUnder(normalized, directories) {
  return directories.some((directory) => normalized.startsWith(`${directory}/`));
}

function isRepoFile(root, normalized) {
  const absolute = path.resolve(root, normalized);
  return existsSync(absolute) && statSync(absolute).isFile();
}

function validateTestWitness(spec, root, changed) {
  const errors = [];
  if (!spec.testFile) {
    errors.push("add one `test: test/...test.ts` line");
  } else {
    const testFile = normalizeRepoPath(spec.testFile);
    if (!testFile || !isUnder(testFile, ["test"]) || !isRepoFile(root, testFile)) {
      errors.push(`test file is missing or outside test/: ${spec.testFile}`);
    } else if (!testFile.endsWith(".ts")) {
      errors.push(`test file must be TypeScript: ${spec.testFile}`);
    }
  }
  if (spec.sources.length === 0) {
    errors.push("add at least one `src: src/...` (or `src: scripts/...`) line");
  }
  for (const source of spec.sources) {
    const normalized = normalizeRepoPath(source);
    // A source the PR deletes or moves is gone from the head checkout. The
    // verifier restores it from the base on the red side, so accept it when
    // the diff names it.
    const valid =
      normalized &&
      isUnder(normalized, SOURCE_DIRECTORIES) &&
      (isRepoFile(root, normalized) || changed.has(normalized));
    if (!valid) {
      errors.push(`source file is missing, outside src/ or scripts/, and not deleted by this PR: ${source}`);
    }
  }
  return errors;
}

function validateRemovalWitness(spec, root, changed) {
  const errors = [];
  if (spec.gone.length === 0 && spec.absent.length === 0) {
    errors.push("a removal witness needs at least one `gone: <path>` or `absent: <text>` line");
  }
  if (spec.testFile || spec.sources.length > 0) {
    errors.push("a removal witness takes `gone:` and `absent:` lines, not `test:` or `src:`");
  }
  for (const gone of spec.gone) {
    const normalized = normalizeRepoPath(gone);
    if (!normalized) {
      errors.push(`gone path must be relative to the repo: ${gone}`);
    } else if (isRepoFile(root, normalized)) {
      errors.push(`gone path still exists at the head: ${gone}`);
    } else if (!changed.has(normalized)) {
      errors.push(`gone path is not deleted by this PR: ${gone}`);
    }
  }
  return errors;
}

export function validateWitnessSpec(spec, root = process.cwd(), changedFiles = []) {
  const changed = new Set(changedFiles.map((file) => String(file).replaceAll("\\", "/")));
  const errors = [
    ...spec.errors,
    ...(spec.kind === "removal"
      ? validateRemovalWitness(spec, root, changed)
      : validateTestWitness(spec, root, changed)),
  ];
  return [...new Set(errors)];
}

function filledSpecs(body) {
  return extractWitnessBlocks(body)
    .map(parseWitnessBlock)
    .filter(isFilled);
}

function isFilled(spec) {
  return (
    spec.testFile ||
    spec.sources.length > 0 ||
    spec.gone.length > 0 ||
    spec.absent.length > 0 ||
    spec.errors.length > 0 ||
    spec.kind !== "test"
  );
}

function specSignature(spec) {
  const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b));
  return JSON.stringify({
    kind: spec.kind,
    testFile: spec.testFile,
    sources: sorted(spec.sources),
    gone: sorted(spec.gone),
    absent: sorted(spec.absent),
  });
}

export function witnessDecision({ body, labels = [], root = process.cwd(), changedFiles = [] }) {
  const normalizedLabels = labels.map((label) => label.trim().toLowerCase()).filter(Boolean);
  const requiresWitness = normalizedLabels.some((label) => BEHAVIOR_LABELS.has(label));
  const optedOut = normalizedLabels.includes(OPT_OUT_LABEL);
  const changedSources = changedFiles
    .map((file) => String(file).replaceAll("\\", "/"))
    .filter((file) => file.startsWith("src/"));

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

  const errors = validateWitnessSpec(spec, root, changedFiles);
  if (errors.length > 0) return { action: "fail", reason: errors.join("; "), spec };
  return { action: spec.kind === "removal" ? "removal" : "run", spec };
}

function gitStatus(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status; // NOSONAR:S4036 -- git from PATH, as above.
}

/**
 * Prove a deletion: every `gone:` path existed at the base and is absent at
 * the head, and every `absent:` text (a command id, a setting key, a class
 * name) appears under src/ at the base and nowhere under src/ at the head.
 */
export function checkRemoval({ base, spec, cwd = process.cwd() }) {
  const results = [];
  for (const gone of spec.gone) {
    const atBase = gitStatus(["cat-file", "-e", `${base}:${gone}`], cwd) === 0;
    const atHead = gitStatus(["cat-file", "-e", `HEAD:${gone}`], cwd) === 0;
    results.push({
      check: `gone: ${gone}`,
      ok: atBase && !atHead,
      detail: !atBase ? "missing at the base, so the PR did not remove it" : atHead ? "still present at the head" : "present at the base, absent at the head",
    });
  }
  for (const text of spec.absent) {
    const grep = (ref) => gitStatus(["grep", "-q", "-F", "-e", text, ref, "--", "src"], cwd) === 0;
    const atBase = grep(base);
    const atHead = grep("HEAD");
    results.push({
      check: `absent: ${text}`,
      ok: atBase && !atHead,
      detail: !atBase ? "not found under src/ at the base, so it proves nothing" : atHead ? "still found under src/ at the head" : "found at the base, gone at the head",
    });
  }
  return { verdict: results.every((result) => result.ok) ? "PASS" : "FAIL", results };
}

function changedFiles(base, cwd) {
  // -z and --no-renames keep non-ASCII names unquoted and show a move out of
  // src/ as a deletion plus an addition.
  const result = spawnSync(
    "git", // NOSONAR:S4036 -- git is the repository tool, resolved from PATH in CI.
    ["diff", "--name-only", "-z", "--no-renames", `${base}...HEAD`],
    { cwd, encoding: "buffer" },
  );
  if (result.status !== 0) return null;
  return result.stdout
    .toString("utf8")
    .split("\0")
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
      "A deletion can prove the entry point is gone instead:",
      "<!-- witness",
      "kind: removal",
      "gone: src/old-feature.ts",
      "absent: agentic-chat:old-command",
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
  if (decision.action === "removal") {
    const removal = checkRemoval({ base, spec: decision.spec, cwd });
    console.log(`witness: removal ${removal.verdict} against ${base}`);
    for (const result of removal.results) {
      console.log(`  ${result.ok ? "ok  " : "FAIL"} ${result.check} (${result.detail})`);
    }
    process.exitCode = removal.verdict === "PASS" ? 0 : 1;
    return;
  }

  const args = [
    // The verifier next to this script, not the one in cwd: CI runs both from
    // the trusted base checkout while cwd is the PR head being measured.
    fileURLToPath(new URL("./verify-witness.mjs", import.meta.url)),
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
