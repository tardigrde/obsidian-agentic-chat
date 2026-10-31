#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const NODE = process.execPath;
const SMOKE_SPEC = "test/e2e/specs/smoke.e2e.ts";
const DESIGN_AUDIT_SPEC = "test/e2e/specs/design-audit.e2e.ts";

function bin(name) {
  return path.resolve("node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function step(label, command, args, options = {}) {
  return { label, command, args, expectTests: false, ...options };
}

const lanes = {
  fast: () => [
    step("typecheck", bin("tsc"), ["-noEmit"]),
    step("e2e typecheck", bin("tsc"), ["-p", "tsconfig.e2e.json", "--noEmit"]),
    step("lint", bin("eslint"), ["."]),
    step("lint:obsidian", bin("eslint"), ["-c", "eslint.config.obsidian.mjs", "src"]),
    step("unit tests", bin("vitest"), ["run"], { expectTests: true }),
    step("production bundle", NODE, ["esbuild.config.mjs", "production"]),
    step("release verification", NODE, ["scripts/verify-release.mjs"]),
    step("mobile compatibility", NODE, ["scripts/verify-mobile-compat.mjs"]),
    step("smoke e2e", NODE, ["--import", "tsx", "scripts/run-e2e.ts", "--spec", SMOKE_SPEC], {
      expectTests: true,
      explainE2eSandboxFailure: true,
    }),
  ],

  ci: () => [
    step("typecheck", bin("tsc"), ["-noEmit"]),
    step("lint", bin("eslint"), ["."]),
    step("lint:obsidian", bin("eslint"), ["-c", "eslint.config.obsidian.mjs", "src"]),
    step("unit tests with coverage", bin("vitest"), ["run", "--coverage"], { expectTests: true }),
    step("production bundle", NODE, ["esbuild.config.mjs", "production"]),
  ],

  smoke: () => [
    step("production bundle", NODE, ["esbuild.config.mjs", "production"]),
    step("smoke e2e", NODE, ["--import", "tsx", "scripts/run-e2e.ts", "--spec", SMOKE_SPEC], {
      expectTests: true,
      explainE2eSandboxFailure: true,
    }),
  ],

  change: (args) => {
    if (args.length === 0) {
      throw new Error("verify change needs a test file or a -t pattern, for example: npm run verify -- change test/settings.test.ts");
    }
    const target = args[0];
    const isPath = target.includes("/") || target.endsWith(".test.ts");
    const vitestArgs = isPath ? ["run", target] : ["run", "-t", target];
    return [step("unit tests", bin("vitest"), vitestArgs, { expectTests: true })];
  },

  e2e: (args) => {
    const forwarded = args.length > 0 && !args[0].startsWith("-") ? ["--spec", ...args] : args;
    return [
      step("e2e bundle", NODE, ["scripts/build-e2e.mjs"]),
      step("e2e", NODE, ["--import", "tsx", "scripts/run-e2e.ts", ...forwarded], {
        expectTests: true,
        explainE2eSandboxFailure: true,
      }),
    ];
  },

  dogfood: () => [
    step("dogfood e2e", NODE, ["--import", "tsx", "scripts/run-dogfood-e2e.ts"], {
      timeoutMs: 60 * 60 * 1000,
    }),
  ],

  eval: (args) => [
    step("agentic evals", NODE, ["--import", "tsx", "scripts/run-agentic-evals.ts", ...args]),
  ],

  audit: (args) => {
    const mode = args[0] ?? "sidebar";
    return [
      step("e2e bundle", NODE, ["scripts/build-e2e.mjs"]),
      step("design audit", NODE, ["--import", "tsx", "scripts/run-e2e.ts", "--spec", DESIGN_AUDIT_SPEC], {
        env: { AGENTIC_CHAT_DESIGN_AUDIT: "1", AGENTIC_CHAT_DESIGN_AUDIT_MODE: mode },
        expectTests: true,
        explainE2eSandboxFailure: true,
      }),
    ];
  },

  all: () => [
    ...lanes.fast(),
    step("e2e bundle", NODE, ["scripts/build-e2e.mjs"]),
    step("e2e", NODE, ["--import", "tsx", "scripts/run-e2e.ts"], {
      expectTests: true,
      explainE2eSandboxFailure: true,
    }),
    step("dogfood e2e", NODE, ["--import", "tsx", "scripts/run-dogfood-e2e.ts"], {
      timeoutMs: 60 * 60 * 1000,
    }),
    step("agentic evals", NODE, ["--import", "tsx", "scripts/run-agentic-evals.ts"]),
  ],
};

function usage() {
  const names = Object.keys(lanes).join(", ");
  return `Usage: npm run verify -- <lane> [args]

Lanes: ${names}

  fast              Merge gate: typecheck, lints, unit, production build, smoke e2e
  ci                What CI runs: typecheck, lints, unit with coverage, production build
  smoke             Production build plus the no-key smoke e2e
  change <target>   One unit file, or a -t pattern
  e2e [spec]        E2E bundle plus one spec (defaults to the whole suite)
  dogfood           Generated-vault dogfood e2e
  eval [args]       Agentic evals; pass through --suite, --run-judge, etc.
  audit [mode]      Design audit at sidebar|wide|mobile|fullscreen
  all               Everything above, including dogfood and evals

Examples:
  npm run verify -- fast
  npm run verify -- change test/settings.test.ts
  npm run verify -- change "uses the generic provider model id"
  npm run verify -- e2e test/e2e/specs/settings-ui.e2e.ts
  npm run verify -- audit wide
`;
}

function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key === "INIT_CWD") delete env[key];
  }
  return { ...env, ...extra };
}

function runStep(s) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let settled = false;
    let timedOut = false;

    const child = spawn(s.command, s.args, {
      env: childEnv(s.env),
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ...s,
        code: timedOut ? 124 : code ?? 1,
        output,
        durationMs: Date.now() - started,
        timedOut,
      });
    };

    const timer = s.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, s.timeoutMs)
      : undefined;

    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      output += `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
      process.stderr.write(output);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

function firstCountOnLine(output, word) {
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === word && /^\d+$/.test(parts[0])) return Number(parts[0]);
  }
  return undefined;
}

function countFor(text, word) {
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index + 1] === word && /^\d+$/.test(tokens[index])) return Number(tokens[index]);
  }
  return undefined;
}

function parseVitest(output) {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Tests")) continue;
    const open = trimmed.indexOf("(");
    const close = trimmed.lastIndexOf(")");
    if (open <= 0 || close <= open) continue;
    const total = Number(trimmed.slice(open + 1, close));
    if (!Number.isFinite(total)) continue;
    const parts = trimmed.slice(0, open);
    return {
      passed: countFor(parts, "passed") ?? 0,
      failed: countFor(parts, "failed") ?? 0,
      skipped: countFor(parts, "skipped") ?? 0,
      total,
      kind: "vitest",
    };
  }
  return null;
}

function parseMocha(output) {
  const passed = firstCountOnLine(output, "passing");
  if (passed === undefined) return null;
  const failed = firstCountOnLine(output, "failing") ?? 0;
  const skipped = firstCountOnLine(output, "pending") ?? 0;
  return { passed, failed, skipped, total: passed + failed + skipped, kind: "mocha" };
}

function parseWdioSpecs(output) {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Spec Files:")) continue;
    const tokens = trimmed.split(/\s+/);
    const passed = countBeforeToken(tokens, "passed");
    const total = countBeforeToken(tokens, "total");
    if (passed === undefined || total === undefined) continue;
    return {
      passed,
      failed: total - passed,
      skipped: 0,
      total,
      kind: "wdio-specs",
    };
  }
  return null;
}

function countBeforeToken(tokens, suffix) {
  const index = tokens.findIndex((token) => token.startsWith(suffix));
  if (index <= 0) return undefined;
  const value = Number(tokens[index - 1].replace(",", ""));
  return Number.isFinite(value) ? value : undefined;
}

export function parseCounts(output) {
  return parseVitest(output) ?? parseMocha(output) ?? parseWdioSpecs(output);
}

function stepStatus(result) {
  if (result.timedOut) return "TIMEOUT";
  if (result.code !== 0) return "FAIL";
  const counts = parseCounts(result.output);
  if (result.expectTests && counts) {
    if (counts.total === 0) return "FAIL";
    if (counts.passed === 0 && counts.skipped > 0) return "FAIL";
  }
  return "PASS";
}

function detailFor(result, status) {
  const counts = parseCounts(result.output);
  if (status === "TIMEOUT") return `no exit within ${Math.round((result.timeoutMs ?? 0) / 1000)}s`;
  if (counts) {
    const skipped = counts.skipped > 0 ? `, ${counts.skipped} skipped` : "";
    return `${counts.passed} passed, ${counts.failed} failed${skipped} (${counts.kind})`;
  }
  if (result.expectTests && status === "PASS") return "exit 0, no test count found";
  return `exit ${result.code}`;
}

function explainStatus(result, status) {
  const counts = parseCounts(result.output);
  if (status !== "FAIL" || !result.expectTests || !counts) return;
  if (counts.total === 0) {
    process.stderr.write(
      `\n[verify] ${result.label} exited 0 but ran no tests. Treat that as a failure, not a pass.\n`,
    );
  } else if (counts.passed === 0 && counts.skipped > 0) {
    process.stderr.write(
      `\n[verify] ${result.label} exited 0 because every test skipped (${counts.skipped}). ` +
        "Set the credentials or environment it needs, or run a lane that can actually execute.\n",
    );
  }
}

export function isTsxIpcSandboxFailure(output) {
  return /listen EPERM: operation not permitted .*tsx-\d+\/.+\.pipe/s.test(output);
}

export function isChromedriverSandboxFailure(output) {
  return /CreatePlatformSocket\(\) failed: Operation not permitted|Could not start chromedriver/s.test(output);
}

function isKnownNestedE2eSandboxFailure(output) {
  return output.trim() === "" || isTsxIpcSandboxFailure(output) || isChromedriverSandboxFailure(output);
}

function printNestedE2eSandboxHint(output) {
  if (!isKnownNestedE2eSandboxFailure(output)) return;
  process.stderr.write(`
[verify] The core checks passed, but the smoke e2e runner did not start.
[verify] In sandboxed shells this can happen when nested e2e needs local IPC/listen sockets.
[verify] Rerun the smoke e2e as a top-level command:
[verify]   rtk npm run verify -- smoke
`);
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "step";
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function printTable(results, lane) {
  const labelWidth = Math.max(5, ...results.map((result) => result.label.length));
  const statusWidth = 7;
  process.stdout.write(`\n[verify] lane: ${lane}\n`);
  for (const result of results) {
    const status = stepStatus(result);
    const detail = detailFor(result, status);
    process.stdout.write(
      `  ${pad(status, statusWidth)} ${pad(result.label, labelWidth)}  ${pad(formatDuration(result.durationMs), 8)}  ${detail}\n`,
    );
  }
}

async function writeSummary(results, lane, startedAt, finishedAt, verdict) {
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const dir = path.resolve("logs", "verify", stamp);
  await mkdir(dir, { recursive: true });

  const steps = await Promise.all(
    results.map(async (result, index) => {
      const status = stepStatus(result);
      const counts = parseCounts(result.output);
      const logName = `${String(index + 1).padStart(2, "0")}-${slug(result.label)}.log`;
      await writeFile(path.join(dir, logName), result.output);
      return {
        label: result.label,
        status,
        code: result.code,
        durationMs: result.durationMs,
        counts,
        log: logName,
        command: [result.command, ...result.args].join(" "),
      };
    }),
  );

  const summary = {
    lane,
    verdict,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    steps,
  };
  await writeFile(path.join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  const rows = steps
    .map(
      (entry) =>
        `| ${entry.status} | ${entry.label} | ${formatDuration(entry.durationMs)} | ${
          entry.counts
            ? `${entry.counts.passed} passed, ${entry.counts.failed} failed, ${entry.counts.skipped} skipped`
            : `exit ${entry.code}`
        } |`,
    )
    .join("\n");
  await writeFile(
    path.join(dir, "summary.md"),
    `# Verify: ${lane}\n\n- verdict: **${verdict}**\n- duration: ${formatDuration(summary.durationMs)}\n\n| Status | Step | Duration | Detail |\n|---|---|---|---|\n${rows}\n`,
  );

  return dir;
}

async function main() {
  const laneName = process.argv[2] ?? "fast";
  const laneArgs = process.argv.slice(3);

  if (laneName === "--help" || laneName === "-h" || laneName === "help") {
    process.stdout.write(usage());
    return 0;
  }
  if (laneName === "--list") {
    process.stdout.write(`${Object.keys(lanes).join("\n")}\n`);
    return 0;
  }

  const buildLane = lanes[laneName];
  if (!buildLane) {
    process.stderr.write(`Unknown verify lane: ${laneName}\n\n${usage()}`);
    return 1;
  }

  const steps = buildLane(laneArgs);
  const startedAt = Date.now();
  const results = [];

  process.stdout.write(`[verify] ${laneName}: ${steps.length} steps\n`);

  for (const s of steps) {
    process.stdout.write(`\n[verify] ${s.label}\n`);
    const result = await runStep(s);
    results.push(result);
    const status = stepStatus(result);
    explainStatus(result, status);
    if (status === "PASS") continue;

    if (s.explainE2eSandboxFailure) printNestedE2eSandboxHint(result.output);
    printTable(results, laneName);
    const dir = await writeSummary(results, laneName, startedAt, Date.now(), "FAIL");
    const exitCode = result.code === 0 ? 1 : result.code;
    process.stderr.write(`\n[verify] ${s.label} failed with exit code ${exitCode}.\n`);
    process.stderr.write(`[verify] artifacts: ${dir}\n`);
    return exitCode;
  }

  printTable(results, laneName);
  const dir = await writeSummary(results, laneName, startedAt, Date.now(), "PASS");
  process.stdout.write(`\n[verify] all checks passed\n[verify] artifacts: ${dir}\n`);
  return 0;
}

const exitCode = await main();
process.exitCode = exitCode;
