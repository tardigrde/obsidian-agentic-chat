#!/usr/bin/env node
/* global setTimeout, clearTimeout */
/**
 * Break-change run helper.
 *
 * This is an orchestrator, not a new test runner. It wraps the existing
 * `npm run verify -- e2e` lane, captures evidence, and removes the generated
 * spec on success, failure, and interruption.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(SKILL_DIR, "../../..");
const TEMPLATE_DIR = path.join(SKILL_DIR, "templates");
const RUN_ROOT = path.join(REPO_ROOT, "logs", "break-change");
const SPEC_DIR = path.join(REPO_ROOT, "test", "e2e", "specs");
const E2E_ARTIFACT_ROOT = path.join(REPO_ROOT, "logs", "e2e-artifacts");
const FEATURE_MAP_DIR = path.join(REPO_ROOT, ".agents", "skills", "verify-obsidian-chat", "features");

const MODES = new Set(["targeted", "removal", "general"]);
const VERDICTS = new Set(["PASS", "FINDINGS", "INCONCLUSIVE"]);
const IGNORED_DIRS = new Set([
  ".git",
  ".obsidian",
  ".obsidian-cache",
  "node_modules",
  "logs",
  "coverage",
  ".stryker-tmp",
  "reports",
]);
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".css",
  ".html",
  ".txt",
]);

const USAGE = `Usage:
  break-change.mjs init --work-item <text> [--mode targeted|removal|general] [--pr <number>]
  break-change.mjs spec --run <dir> [--force]
  break-change.mjs run --run <dir> [--spec <path>] [--timeout-ms <ms>] [--keep-spec]
  break-change.mjs audit --run <dir> --term <text> [--term <text>...]
  break-change.mjs scan --run <dir> [--limit <n>]
  break-change.mjs event --run <dir> --type <type> [--id <id>] [--verdict <value>] [--detail <text>] [--evidence <path>]
  break-change.mjs report --run <dir>
  break-change.mjs cleanup --run <dir>
  break-change.mjs --self-test
  break-change.mjs --help

The run directory holds run.json, events.jsonl, report.md, the spec snapshot,
run.log, and copied e2e artifacts. Logs stay local; do not commit them.
`;

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) {
      parsed._.push(raw);
      continue;
    }
    const key = raw.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    if (parsed[key] === undefined) parsed[key] = next;
    else if (Array.isArray(parsed[key])) parsed[key].push(next);
    else parsed[key] = [parsed[key], next];
    index += 1;
  }
  return parsed;
}

function one(value) {
  return Array.isArray(value) ? value.at(-1) : value;
}

function many(value) {
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function required(value, name) {
  if (value === undefined || value === true || value === "") throw new Error(`${name} is required`);
  return one(value);
}

function git(args, cwd = REPO_ROOT) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) return { status: 1, stdout: "", stderr: result.error.message };
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function gitOrNull(args) {
  const result = git(args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

function relativeToRepo(target) {
  return path.relative(REPO_ROOT, target).replaceAll(path.sep, "/");
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function appendEvent(runDir, event) {
  await mkdir(runDir, { recursive: true });
  await appendFile(
    path.join(runDir, "events.jsonl"),
    `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
    "utf8",
  );
}

async function loadRun(runArg) {
  const runDir = path.resolve(REPO_ROOT, required(runArg, "--run"));
  const runPath = path.join(runDir, "run.json");
  if (!existsSync(runPath)) throw new Error(`run.json not found at ${runPath}`);
  return { runDir, run: await readJson(runPath), runPath };
}

function replaceTokens(text, tokens) {
  let output = text;
  for (const [token, value] of Object.entries(tokens)) {
    output = output.replaceAll(token, value);
  }
  return output;
}

async function initRun(args) {
  const mode = String(args.mode ?? "targeted");
  if (!MODES.has(mode)) throw new Error(`--mode must be one of ${[...MODES].join(", ")}`);
  const workItem = required(args["work-item"], "--work-item");
  const scenarioCount = Number(one(args["scenario-count"]) ?? "6");
  if (!Number.isInteger(scenarioCount) || scenarioCount < 5 || scenarioCount > 10) {
    throw new Error("--scenario-count must be an integer from 5 to 10");
  }

  const requestedHead = one(args.head) ?? "HEAD";
  const head = gitOrNull(["rev-parse", "--verify", `${requestedHead}^{commit}`]);
  if (!head) throw new Error(`cannot resolve --head ${requestedHead}`);

  let base = one(args.base) ?? "origin/main";
  if (!gitOrNull(["rev-parse", "--verify", `${base}^{commit}`])) {
    const fallback = gitOrNull(["rev-parse", "--verify", "main^{commit}"]) ? "main" : gitOrNull(["rev-parse", "--verify", "HEAD~1^{commit}"]);
    if (!fallback) throw new Error(`cannot resolve --base ${base} and no fallback is available`);
    process.stderr.write(`[break-change] base ${base} is not available; using ${fallback}\n`);
    base = fallback;
  }

  const runId = stamp();
  const runDir = path.resolve(REPO_ROOT, one(args.out) ?? path.join(RUN_ROOT, runId));
  const resolvedRunId = path.basename(runDir);
  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(runDir, "clips"), { recursive: true });
  await mkdir(path.join(runDir, "artifacts"), { recursive: true });

  const range = `${base}...${head}`;
  const nameStatus = git(["diff", "--name-status", range]);
  const stat = git(["diff", "--stat", range]);
  const log = git(["log", "--oneline", "-8", head]);
  await writeJson(path.join(runDir, "change.json"), {
    head,
    base,
    range,
    files: nameStatus.status === 0 ? nameStatus.stdout.trim().split("\n").filter(Boolean) : [],
    stat: stat.status === 0 ? stat.stdout.trim() : "",
    log: log.status === 0 ? log.stdout.trim() : "",
    capturedAt: new Date().toISOString(),
  });

  if (args.pr !== undefined) {
    const pr = one(args.pr);
    const result = spawnSync(
      "gh",
      ["pr", "view", String(pr), "--json", "number,title,body,url,headRefOid,files"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    if (result.status === 0) {
      await writeFile(path.join(runDir, "pr.json"), result.stdout, "utf8");
    } else {
      process.stderr.write(`[break-change] warning: gh pr view ${pr} failed; capture the PR body manually\n`);
    }
  }

  const specName = `break-change.${resolvedRunId}.e2e.ts`;
  const specPath = path.join(SPEC_DIR, specName);
  if (existsSync(specPath)) throw new Error(`generated spec already exists: ${relativeToRepo(specPath)}`);
  const template = await readFile(path.join(TEMPLATE_DIR, "scenario.e2e.ts"), "utf8");
  const tokens = {
    __BREAK_CHANGE_RUN_ID__: resolvedRunId,
    __BREAK_CHANGE_OUT_DIR__: relativeToRepo(runDir),
    __BREAK_CHANGE_WORK_ITEM__: workItem.replaceAll("\n", " "),
    __BREAK_CHANGE_MODE__: mode,
  };
  await writeFile(specPath, replaceTokens(template, tokens), "utf8");

  const reportTemplate = await readFile(path.join(TEMPLATE_DIR, "report.md"), "utf8");
  const startedAt = new Date().toISOString();
  const reportPath = path.join(runDir, "report.md");
  await writeFile(
    reportPath,
    replaceTokens(reportTemplate, {
      ...tokens,
      __BREAK_CHANGE_HEAD__: head,
      __BREAK_CHANGE_BASE__: base,
      __BREAK_CHANGE_STARTED_AT__: startedAt,
      __BREAK_CHANGE_SCENARIO_COUNT__: String(scenarioCount),
    }),
    "utf8",
  );

  const run = {
    version: 1,
    runId: resolvedRunId,
    mode,
    workItem,
    head,
    base,
    startedAt,
    status: "running",
    scenarioCount,
    specPath: relativeToRepo(specPath),
    generatedSpec: true,
    reportPath: relativeToRepo(reportPath),
    logPath: relativeToRepo(path.join(runDir, "run.log")),
    cleanup: { status: "pending", removed: [] },
  };
  await writeJson(path.join(runDir, "run.json"), run);
  await appendEvent(runDir, {
    event: "run_start",
    runId: resolvedRunId,
    mode,
    workItem,
    head,
    base,
    scenarioCount,
  });

  process.stdout.write(`[break-change] run: ${relativeToRepo(runDir)}\n`);
  process.stdout.write(`[break-change] spec: ${relativeToRepo(specPath)}\n`);
  process.stdout.write(`[break-change] report: ${relativeToRepo(reportPath)}\n`);
  process.stdout.write(`[break-change] change: ${relativeToRepo(path.join(runDir, "change.json"))}\n`);
  process.stdout.write(
    "[break-change] next: replace the default scenario list with 5-10 risks for this change, then run the spec.\n",
  );
  if (mode === "removal") {
    process.stdout.write(
      '[break-change] removal audit: node .agents/skills/break-change/scripts/break-change.mjs audit --run <dir> --term <command>\n',
    );
  }
  if (mode === "general") {
    process.stdout.write(
      "[break-change] general scan: node .agents/skills/break-change/scripts/break-change.mjs scan --run <dir>\n",
    );
  }
}

async function restoreSpec(args) {
  const { runDir, run } = await loadRun(args.run);
  const specPath = path.resolve(REPO_ROOT, run.specPath);
  if (existsSync(specPath) && !args.force) {
    throw new Error(`${relativeToRepo(specPath)} already exists; use --force to overwrite`);
  }
  const snapshotPath = path.join(runDir, "spec.snapshot.e2e.ts");
  if (existsSync(snapshotPath)) {
    await cp(snapshotPath, specPath);
  } else {
    const template = await readFile(path.join(TEMPLATE_DIR, "scenario.e2e.ts"), "utf8");
    await writeFile(
      specPath,
      replaceTokens(template, {
        __BREAK_CHANGE_RUN_ID__: run.runId,
        __BREAK_CHANGE_OUT_DIR__: relativeToRepo(runDir),
        __BREAK_CHANGE_WORK_ITEM__: String(run.workItem ?? "").replaceAll("\n", " "),
        __BREAK_CHANGE_MODE__: String(run.mode ?? "targeted"),
      }),
      "utf8",
    );
  }
  process.stdout.write(`[break-change] restored ${relativeToRepo(specPath)}\n`);
}

async function listDirectories(root) {
  if (!existsSync(root)) return new Set();
  const entries = await readdir(root, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

function countBefore(tokens, suffix) {
  const index = tokens.findIndex((token) => token.startsWith(suffix));
  if (index <= 0) return undefined;
  const value = Number(tokens[index - 1].replaceAll(",", ""));
  return Number.isFinite(value) ? value : undefined;
}

function parseCounts(text) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let sawMocha = false;
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || !/^\d+$/.test(parts[0])) continue;
    const count = Number(parts[0]);
    if (parts[1] === "passing") {
      passed += count;
      sawMocha = true;
    } else if (parts[1] === "failing") {
      failed += count;
      sawMocha = true;
    } else if (parts[1] === "pending" || parts[1] === "skipped") {
      skipped += count;
      sawMocha = true;
    }
  }
  if (sawMocha) return { passed, failed, skipped, total: passed + failed + skipped, kind: "mocha" };

  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("Spec Files:")) continue;
    const tokens = line.trim().split(/\s+/);
    const total = countBefore(tokens, "total");
    const passedCount = countBefore(tokens, "passed");
    if (total !== undefined && passedCount !== undefined) {
      return { passed: passedCount, failed: total - passedCount, skipped: 0, total, kind: "wdio-specs" };
    }
  }
  return null;
}

function mergeNoProxy(current) {
  const values = new Set((current ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  for (const value of ["localhost", "127.0.0.1", "::1"]) values.add(value);
  return [...values].join(",");
}

/**
 * WDIO can print the chromedriver spawn environment when a session fails. That
 * dump contains every local secret. Redact known values and common token shapes
 * before anything reaches stdout, run.log, or a copied artifact.
 */
function buildSecretRedactor() {
  const secrets = new Set();
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (!/(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|COOKIE)/i.test(key)) continue;
    if (/^(PATH|HOME|USER|SHELL|PWD|OLDPWD|TERM|LANG|LC_|XDG_|SSH_AUTH_SOCK)$/i.test(key)) continue;
    secrets.add(value);
  }
  return (text) => {
    let output = String(text);
    for (const secret of secrets) output = output.split(secret).join("[REDACTED]");
    output = output.replace(/sk-or-v1-[A-Za-z0-9]{8,}/g, "[REDACTED]");
    output = output.replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]");
    output = output.replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/g, "$1[REDACTED]");
    return output;
  };
}

function createRedactingWriter(onText) {
  const redact = buildSecretRedactor();
  let carry = "";
  const flush = (line) => onText(redact(line));
  return {
    write(chunk) {
      carry += chunk.toString();
      let index = carry.indexOf("\n");
      while (index !== -1) {
        flush(carry.slice(0, index + 1));
        carry = carry.slice(index + 1);
        index = carry.indexOf("\n");
      }
    },
    end() {
      if (carry) flush(carry);
      carry = "";
    },
  };
}

/**
 * Redact a directory in place. The caller must copy only after this resolves.
 * A write goes to a sibling temp file first, then renames, so a killed writer
 * cannot leave a half-redacted file that looks complete.
 */
export async function redactArtifactTree(root, shouldAbort = () => false) {
  const redact = buildSecretRedactor();
  const textExtensions = new Set([".json", ".jsonl", ".txt", ".log", ".md", ".html", ".xml", ".csv"]);
  const visit = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldAbort()) throw new Error("interrupted during artifact redaction");
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile() || !textExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const text = await readFile(full, "utf8");
      const redacted = redact(text);
      if (redacted === text) continue;
      const temporary = `${full}.redact-${process.pid}.tmp`;
      try {
        await writeFile(temporary, redacted, "utf8");
        await rename(temporary, full);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
  };
  await visit(root);
}

async function newArtifactNames(before) {
  const after = await listDirectories(E2E_ARTIFACT_ROOT);
  return [...after].filter((name) => !before.has(name)).sort();
}

/**
 * Redact source artifacts first, then copy the clean tree to the run directory.
 * Any abort or redaction failure removes both the source and target trees, so an
 * unredacted artifact cannot survive as evidence.
 */
export async function copyArtifactDirectories({
  sourceRoot,
  targetRoot,
  names,
  shouldAbort = () => false,
}) {
  const copied = [];
  try {
    for (const name of names) {
      if (shouldAbort()) throw new Error("interrupted during artifact handling");
      await redactArtifactTree(path.join(sourceRoot, name), shouldAbort);
    }
    for (const name of names) {
      if (shouldAbort()) throw new Error("interrupted during artifact handling");
      const target = path.join(targetRoot, name);
      await cp(path.join(sourceRoot, name), target, { recursive: true, force: true });
      copied.push(target);
    }
    return copied;
  } catch (error) {
    for (const name of names) {
      await rm(path.join(sourceRoot, name), { recursive: true, force: true }).catch(() => undefined);
      await rm(path.join(targetRoot, name), { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function removeGeneratedSpec(run, runDir) {
  const specPath = path.resolve(REPO_ROOT, run.specPath);
  const expectedDir = path.resolve(SPEC_DIR);
  if (path.dirname(specPath) !== expectedDir) {
    return { removed: false, reason: "spec is outside test/e2e/specs" };
  }
  if (!path.basename(specPath).startsWith("break-change.")) {
    return { removed: false, reason: "spec is not a generated break-change spec" };
  }
  if (!existsSync(specPath)) return { removed: false, reason: "spec already absent" };
  await rm(specPath, { force: true });
  await appendEvent(runDir, { event: "spec_cleanup", path: relativeToRepo(specPath) });
  return { removed: true, path: relativeToRepo(specPath) };
}

async function runSpec(args) {
  const { runDir, run, runPath } = await loadRun(args.run);
  const specPath = args.spec ? path.resolve(REPO_ROOT, one(args.spec)) : path.resolve(REPO_ROOT, run.specPath);
  if (!specPath.startsWith(`${REPO_ROOT}${path.sep}`)) throw new Error("spec must be inside the repository");
  if (!existsSync(specPath)) {
    throw new Error(`spec not found: ${relativeToRepo(specPath)}. Restore it with: ... spec --run ${relativeToRepo(runDir)}`);
  }
  const timeoutMs = Math.min(Number(one(args["timeout-ms"]) ?? "900000"), 1_800_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 60_000) throw new Error("--timeout-ms must be at least 60000");

  const snapshotPath = path.join(runDir, "spec.snapshot.e2e.ts");
  await cp(specPath, snapshotPath);
  const logPath = path.join(runDir, "run.log");
  const log = createWriteStream(logPath, { flags: "w" });
  const logWriter = createRedactingWriter((text) => log.write(text));
  const stdoutWriter = createRedactingWriter((text) => process.stdout.write(text));
  const stderrWriter = createRedactingWriter((text) => process.stderr.write(text));
  const beforeArtifacts = await listDirectories(E2E_ARTIFACT_ROOT);
  const relativeSpec = relativeToRepo(specPath);
  const startedAt = Date.now();

  process.stdout.write(`[break-change] running ${relativeSpec} through npm run verify -- e2e\n`);
  const child = spawn(npmCommand(), ["run", "verify", "--", "e2e", relativeSpec], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      BREAK_CHANGE_RUN_DIR: runDir,
      BREAK_CHANGE_RUN_ID: run.runId,
      BREAK_CHANGE_MODE: run.mode,
      NO_PROXY: mergeNoProxy(process.env.NO_PROXY),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let interrupted = null;
  const onSignal = (signal) => {
    interrupted = signal;
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const result = await new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutWriter.write(chunk);
      logWriter.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrWriter.write(chunk);
      logWriter.write(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      logWriter.write(`${error.stack ?? error.message}\n`);
      resolve({ code: 1, timedOut, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, timedOut });
    });
  });

  logWriter.end();
  stdoutWriter.end();
  stderrWriter.end();
  await new Promise((resolve) => log.end(resolve));

  const output = await readFile(logPath, "utf8").catch(() => "");
  const counts = parseCounts(output);
  const freshArtifacts = await newArtifactNames(beforeArtifacts);
  let copiedArtifacts = [];
  let artifactError = null;
  try {
    copiedArtifacts = (
      await copyArtifactDirectories({
        sourceRoot: E2E_ARTIFACT_ROOT,
        targetRoot: path.join(runDir, "e2e-artifacts"),
        names: freshArtifacts,
        shouldAbort: () => interrupted !== null,
      })
    ).map(relativeToRepo);
  } catch (error) {
    artifactError = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[break-change] artifact safety failure: ${artifactError}\n`);
  }
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);

  const exitCode = interrupted ? 130 : artifactError ? 1 : result.code;
  const status = interrupted ? "interrupted" : artifactError || exitCode !== 0 ? "failed" : "completed";
  const finishedAt = new Date().toISOString();
  const updated = {
    ...run,
    status,
    exitCode,
    timedOut: Boolean(result.timedOut),
    counts,
    durationMs: Date.now() - startedAt,
    finishedAt,
    logPath: relativeToRepo(logPath),
    specSnapshot: relativeToRepo(snapshotPath),
    e2eArtifacts: copiedArtifacts,
    ...(artifactError ? { artifactError } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(interrupted ? { interruptedBy: interrupted } : {}),
  };

  const cleanup = args["keep-spec"] ? { removed: false, reason: "--keep-spec" } : await removeGeneratedSpec(run, runDir);
  updated.cleanup = { status: cleanup.removed ? "removed" : "kept", last: cleanup };
  await writeJson(runPath, updated);
  await appendEvent(runDir, {
    event: "run_end",
    exitCode,
    status,
    counts,
    durationMs: updated.durationMs,
    artifacts: copiedArtifacts,
    cleanup,
    ...(artifactError ? { artifactError } : {}),
  });

  process.stdout.write(`\n[break-change] status: ${status}\n`);
  if (artifactError) {
    process.stdout.write(`[break-change] artifact safety failure: ${artifactError}\n`);
  }
  process.stdout.write(`[break-change] exit: ${exitCode}\n`);
  if (counts) {
    process.stdout.write(
      `[break-change] counts: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped (${counts.kind})\n`,
    );
  } else {
    process.stdout.write("[break-change] counts: no test summary found; read run.log before trusting the run\n");
  }
  process.stdout.write(`[break-change] log: ${relativeToRepo(logPath)}\n`);
  if (copiedArtifacts.length > 0) {
    process.stdout.write(`[break-change] artifacts: ${copiedArtifacts.join(", ")}\n`);
  }
  if (cleanup.removed) {
    process.stdout.write(`[break-change] removed generated spec: ${cleanup.path}\n`);
  } else {
    process.stdout.write(`[break-change] spec kept: ${cleanup.reason ?? "unknown"}\n`);
  }
  process.stdout.write(
    `[break-change] next: fill ${relativeToRepo(path.join(runDir, "report.md"))}, then run ... report --run ${relativeToRepo(runDir)}\n`,
  );
  process.exitCode = exitCode;
}

async function walkFiles(dir, visit, root = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll(path.sep, "/");
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (rel === "docs/.vitepress/cache" || rel === "docs/.vitepress/dist") continue;
      await walkFiles(full, visit, root);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    await visit(full, rel);
  }
}

async function searchTerm(term) {
  const needle = term.toLowerCase();
  const hits = [];
  await walkFiles(REPO_ROOT, async (full, rel) => {
    const info = await stat(full).catch(() => null);
    if (!info || info.size > 2_000_000) return;
    const text = await readFile(full, "utf8").catch(() => null);
    if (text === null) return;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(needle)) continue;
      hits.push({ path: rel, line: index + 1, text: lines[index].trim().slice(0, 240) });
    }
  });
  return hits;
}

function categoriesFor(hit) {
  const categories = new Set();
  const rel = hit.path;
  if (rel === "src/ui/commands.ts") categories.add("commandRegistry");
  if (rel === "src/ui/chat-view.ts") {
    categories.add("help");
    categories.add("ui");
  } else if (rel.startsWith("src/ui/")) {
    categories.add("ui");
  }
  if (rel === "src/settings.ts") categories.add("ui");
  if (rel === "src/main.ts" || rel === "src/plugin.ts") categories.add("routes");
  if (rel === "manifest.json") categories.add("manifest");
  if (
    rel.startsWith("docs/") ||
    rel === "README.md" ||
    rel === "CHANGELOG.md" ||
    rel === "MOBILE_TESTING.md"
  ) {
    categories.add("docs");
  }
  if (rel.startsWith(".agents/skills/verify-obsidian-chat/features/")) categories.add("featureMap");
  if (rel === ".agents/skills/verify-obsidian-chat/features/commands-and-skills.md") {
    categories.add("slashCommandTable");
  }
  if (rel.startsWith(".agents/skills/")) categories.add("skills");
  if (rel.startsWith("test/")) categories.add("tests");
  if (rel.startsWith("scripts/")) categories.add("scripts");
  if (rel.startsWith("src/")) categories.add("source");
  if (/(^|\s)(import|export)\b/.test(hit.text) || hit.text.includes("from \"")) categories.add("imports");
  if (/registerCommand|addCommand|executeCommand|addRibbonIcon|addSettingTab/.test(hit.text)) {
    categories.add("routes");
  }
  if (categories.size === 0) categories.add("other");
  return [...categories];
}

function surfaceTable() {
  return {
    commandRegistry: [],
    help: [],
    ui: [],
    docs: [],
    slashCommandTable: [],
    featureMap: [],
    imports: [],
    routes: [],
    manifest: [],
    skills: [],
    tests: [],
    scripts: [],
    source: [],
    other: [],
  };
}

async function audit(args) {
  const { runDir } = await loadRun(args.run);
  const terms = many(args.term);
  if (terms.length === 0) throw new Error("audit needs at least one --term");

  const results = [];
  for (const term of terms) {
    const hits = await searchTerm(term);
    const surfaces = surfaceTable();
    for (const hit of hits) {
      for (const category of categoriesFor(hit)) surfaces[category].push(hit);
    }
    results.push({
      term,
      totalHits: hits.length,
      verdict: hits.length === 0 ? "ABSENT" : "PRESENT",
      surfaceCounts: Object.fromEntries(Object.entries(surfaces).map(([key, value]) => [key, value.length])),
      surfaces,
    });
  }

  const output = { generatedAt: new Date().toISOString(), runDir: relativeToRepo(runDir), terms: results };
  await writeJson(path.join(runDir, "audit.json"), output);
  await appendEvent(runDir, {
    event: "audit",
    terms: results.map((result) => ({
      term: result.term,
      verdict: result.verdict,
      totalHits: result.totalHits,
      surfaceCounts: result.surfaceCounts,
    })),
  });

  const labels = [
    "term",
    "total",
    "registry",
    "help",
    "ui",
    "docs",
    "table",
    "map",
    "imports",
    "routes",
    "tests",
    "skills",
    "other",
  ];
  const rows = results.map((result) => [
    result.term,
    result.totalHits,
    result.surfaceCounts.commandRegistry,
    result.surfaceCounts.help,
    result.surfaceCounts.ui,
    result.surfaceCounts.docs,
    result.surfaceCounts.slashCommandTable,
    result.surfaceCounts.featureMap,
    result.surfaceCounts.imports,
    result.surfaceCounts.routes,
    result.surfaceCounts.tests,
    result.surfaceCounts.skills,
    result.surfaceCounts.other,
  ]);
  printTable(labels, rows);
  process.stdout.write(`[break-change] audit: ${relativeToRepo(path.join(runDir, "audit.json"))}\n`);
  process.stdout.write(
    "[break-change] PRESENT is not automatically a failure. Inspect each hit; a removal passes when the registry, /help, UI, docs, feature map, imports, and routes are clean or intentionally historical.\n",
  );
}

function parseFeatureMapRows(file, text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length < 4) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const status = cells.at(-1).replaceAll("`", "").trim();
    if (status !== "partial" && status !== "NONE") continue;
    rows.push({
      file: relativeToRepo(file),
      line: index + 1,
      entry: cells[0].replaceAll("`", ""),
      source: cells[1],
      proof: cells[2],
      status,
    });
  }
  return rows;
}

function riskOf(row) {
  let score = row.status === "NONE" ? 3 : 1;
  const text = `${row.entry} ${row.proof}`.toLowerCase();
  if (/(command|setting|approval|session|tab|mcp|skill|context|composer|permission)/.test(text)) score += 2;
  if (row.entry.startsWith("/") || row.entry.includes("/")) score += 1;
  if (row.proof.toLowerCase().includes("no committed check")) score += 1;
  return score;
}

async function scan(args) {
  const { runDir } = await loadRun(args.run);
  const limit = Math.max(1, Math.min(50, Number(one(args.limit) ?? "10")));
  const candidates = [];
  await walkFiles(FEATURE_MAP_DIR, async (full, rel) => {
    if (!rel.endsWith(".md")) return;
    const text = await readFile(full, "utf8");
    candidates.push(...parseFeatureMapRows(full, text));
  });
  const sorted = candidates
    .map((row) => ({ ...row, risk: riskOf(row) }))
    .sort((a, b) => b.risk - a.risk || a.file.localeCompare(b.file) || a.line - b.line);

  await writeJson(path.join(runDir, "scan.json"), {
    generatedAt: new Date().toISOString(),
    featureMap: relativeToRepo(FEATURE_MAP_DIR),
    total: sorted.length,
    partial: sorted.filter((row) => row.status === "partial").length,
    none: sorted.filter((row) => row.status === "NONE").length,
    candidates: sorted,
  });
  await appendEvent(runDir, {
    event: "scan",
    total: sorted.length,
    partial: sorted.filter((row) => row.status === "partial").length,
    none: sorted.filter((row) => row.status === "NONE").length,
    top: sorted.slice(0, limit).map((row) => ({ file: row.file, line: row.line, entry: row.entry, status: row.status, risk: row.risk })),
  });

  printTable(
    ["risk", "status", "entry", "source", "proof", "file:line"],
    sorted.slice(0, limit).map((row) => [
      row.risk,
      row.status,
      row.entry,
      row.source,
      row.proof,
      `${row.file}:${row.line}`,
    ]),
  );
  process.stdout.write(`[break-change] scan: ${relativeToRepo(path.join(runDir, "scan.json"))}\n`);
  process.stdout.write(
    "[break-change] pick 1-3 high-risk rows, then aim 5-10 scenarios at the behavior. Do not try to cover the whole map in one run.\n",
  );
}

async function recordEvent(args) {
  const { runDir } = await loadRun(args.run);
  const type = required(args.type, "--type");
  const event = {
    event: type,
    ...(args.id !== undefined ? { id: one(args.id) } : {}),
    ...(args.verdict !== undefined ? { verdict: one(args.verdict) } : {}),
    ...(args.detail !== undefined ? { detail: one(args.detail) } : {}),
    ...(args.evidence !== undefined ? { evidence: many(args.evidence) } : {}),
  };
  await appendEvent(runDir, event);
  process.stdout.write(`[break-change] event: ${JSON.stringify(event)}\n`);
}

function section(text, heading) {
  const marker = `## ${heading}`;
  const start = text.indexOf(marker);
  if (start === -1) return "";
  const next = text.indexOf("\n## ", start + marker.length);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

function countRows(text, pattern) {
  return text.split("\n").filter((line) => pattern.test(line.trim())).length;
}

async function validateReport(args) {
  const { runDir, run, runPath } = await loadRun(args.run);
  const reportPath = path.join(runDir, "report.md");
  if (!existsSync(reportPath)) throw new Error(`report.md not found at ${reportPath}`);
  const text = await readFile(reportPath, "utf8");
  const errors = [];

  for (const heading of [
    "Verdict",
    "Scope",
    "Scenarios",
    "Findings",
    "UI evidence",
    "Evidence",
    "Limitations",
    "Cleanup",
  ]) {
    if (!text.includes(`## ${heading}`)) errors.push(`missing ## ${heading}`);
  }
  if (run.mode === "removal" && !text.includes("## Removal audit")) errors.push("missing ## Removal audit for removal mode");

  const verdictMatch = /^\s*(?:[-*]\s*)?(?:\*\*)?Verdict(?:\*\*)?\s*:\s*(?:\*\*)?\s*(PASS|FINDINGS|INCONCLUSIVE)\b/im.exec(text);
  const verdict = verdictMatch?.[1]?.toUpperCase();
  if (!verdict || !VERDICTS.has(verdict)) errors.push("Verdict must be one of PASS, FINDINGS, INCONCLUSIVE");

  const scenarioRows = countRows(section(text, "Scenarios"), /^\|\s*S\d+\s*\|/i);
  if (scenarioRows < 5 || scenarioRows > 10) errors.push(`Scenarios needs 5-10 S-id rows, found ${scenarioRows}`);

  const findingRows = countRows(section(text, "Findings"), /^\|\s*F\d+\s*\|/i);
  if (verdict === "FINDINGS" && findingRows === 0) errors.push("FINDINGS needs at least one F-id row in ## Findings");
  if (verdict === "PASS" && findingRows > 0) errors.push("PASS cannot carry F-id rows; use FINDINGS or remove them");

  const secretPatterns = [
    /sk-or-v1-[A-Za-z0-9]{8,}/,
    /sk-[A-Za-z0-9]{20,}/,
    /Bearer\s+[A-Za-z0-9._-]{16,}/,
    /AGENTIC_CHAT_API_KEY\s*=\s*(?!<|\.\.\.|\$|"<|'<)[^\s`"']{8,}/,
  ];
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) errors.push(`possible secret in report: ${pattern}`);
  }

  if (errors.length > 0) {
    process.stderr.write("[break-change] report validation failed:\n");
    for (const error of errors) process.stderr.write(`  - ${error}\n`);
    process.exitCode = 1;
    return;
  }

  const updated = {
    ...run,
    status: "complete",
    reportVerdict: verdict,
    reportValidatedAt: new Date().toISOString(),
  };
  await writeJson(runPath, updated);
  await appendEvent(runDir, { event: "report_validated", verdict, scenarioRows, findingRows });
  process.stdout.write(`[break-change] report: PASS (${verdict}, ${scenarioRows} scenarios, ${findingRows} findings)\n`);
}

async function cleanup(args) {
  const { runDir, run, runPath } = await loadRun(args.run);
  const removed = [];
  const specCleanup = await removeGeneratedSpec(run, runDir);
  if (specCleanup.removed) removed.push(specCleanup.path);

  const vaultPath = path.join(runDir, "vault");
  if (existsSync(vaultPath) && path.dirname(vaultPath) === runDir) {
    await rm(vaultPath, { recursive: true, force: true });
    removed.push(relativeToRepo(vaultPath));
  }

  const updated = {
    ...run,
    cleanup: {
      status: removed.length > 0 ? "removed" : "clean",
      removed,
      cleanedAt: new Date().toISOString(),
    },
  };
  await writeJson(runPath, updated);
  await appendEvent(runDir, { event: "cleanup", removed, specCleanup });
  process.stdout.write(`[break-change] cleanup: ${removed.length > 0 ? removed.join(", ") : "nothing to remove"}\n`);
  process.stdout.write("[break-change] the e2e service owns its sandbox vault and removes it after the run.\n");
}

function printTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[index] ?? "").length)),
  );
  const format = (row) =>
    row
      .map((cell, index) => String(cell ?? "").padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  process.stdout.write([format(headers), ...rows.map(format)].join("\n") + "\n");
}

/** Prove that redaction happens before copy and an abort leaves no artifact. */
async function selfTest() {
  const root = await mkdtemp(path.join(tmpdir(), "break-change-self-test-"));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  const secretKey = "BREAK_CHANGE_SELF_TEST_SECRET";
  const secretValue = "self-test-secret-value";
  try {
    process.env[secretKey] = secretValue;

    await mkdir(path.join(sourceRoot, "ok"), { recursive: true });
    await writeFile(path.join(sourceRoot, "ok", "artifact.txt"), `prefix ${secretValue} suffix\n`, "utf8");
    const copied = await copyArtifactDirectories({ sourceRoot, targetRoot, names: ["ok"] });
    const copiedText = await readFile(path.join(copied[0], "artifact.txt"), "utf8");
    if (copiedText.includes(secretValue)) throw new Error("self-test: copied artifact kept the secret");
    const sourceText = await readFile(path.join(sourceRoot, "ok", "artifact.txt"), "utf8");
    if (sourceText.includes(secretValue)) throw new Error("self-test: source artifact kept the secret");

    await mkdir(path.join(sourceRoot, "abort"), { recursive: true });
    await writeFile(path.join(sourceRoot, "abort", "artifact.txt"), `prefix ${secretValue} suffix\n`, "utf8");
    let aborted = false;
    try {
      await copyArtifactDirectories({
        sourceRoot,
        targetRoot,
        names: ["abort"],
        shouldAbort: () => true,
      });
    } catch {
      aborted = true;
    }
    if (!aborted) throw new Error("self-test: aborted copy did not throw");
    if (existsSync(path.join(sourceRoot, "abort"))) {
      throw new Error("self-test: aborted copy left the source artifact");
    }
    if (existsSync(path.join(targetRoot, "abort"))) {
      throw new Error("self-test: aborted copy left the target artifact");
    }

    if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
      const failDir = path.join(sourceRoot, "fail");
      await mkdir(failDir, { recursive: true });
      await writeFile(path.join(failDir, "artifact.json"), `prefix ${secretValue} suffix\n`, "utf8");
      await chmod(path.join(failDir, "artifact.json"), 0o000);
      let failed = false;
      try {
        await copyArtifactDirectories({ sourceRoot, targetRoot, names: ["fail"] });
      } catch {
        failed = true;
      }
      if (!failed) throw new Error("self-test: unreadable artifact did not fail");
      if (existsSync(path.join(sourceRoot, "fail"))) {
        throw new Error("self-test: failed redaction left the source artifact");
      }
      if (existsSync(path.join(targetRoot, "fail"))) {
        throw new Error("self-test: failed redaction left the target artifact");
      }
    }

    process.stdout.write("SELF-TEST PASS\n");
  } finally {
    delete process.env[secretKey];
    await rm(root, { recursive: true, force: true });
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (command === "--self-test") {
    await selfTest();
    return;
  }
  const args = parseArgs(rest);
  switch (command) {
    case "init":
      await initRun(args);
      return;
    case "spec":
      await restoreSpec(args);
      return;
    case "run":
      await runSpec(args);
      return;
    case "audit":
      await audit(args);
      return;
    case "scan":
      await scan(args);
      return;
    case "event":
      await recordEvent(args);
      return;
    case "report":
      await validateReport(args);
      return;
    case "cleanup":
      await cleanup(args);
      return;
    default:
      throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`[break-change] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
