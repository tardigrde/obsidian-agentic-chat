import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Every script a lane or CI runs must load the way production runs it:
 * `node --import tsx <script>`. vitest resolves imports as ESM, while tsx runs
 * these scripts as CJS, so a deep import that vitest accepts can still crash
 * the real entry point (#391: `@earendil-works/pi-ai/utils/estimate`). Static
 * imports are evaluated before `--help` is read, so a clean `--help` proves the
 * whole import graph loads.
 */
const TSX_ENTRYPOINTS = [
  "scripts/run-agentic-evals.ts",
  "scripts/run-tool-use-evals.ts",
  "scripts/run-dogfood-e2e.ts",
  "scripts/chaos-monkey.ts",
  "scripts/probe.ts",
  "scripts/eval/trace-miner.ts",
  "scripts/eval/trace-to-case.ts",
];

const NODE_ENTRYPOINTS = [
  "scripts/verify.mjs",
  "scripts/verify-plan.mjs",
  "scripts/verify-witness.mjs",
  "scripts/check-test-manifest.mjs",
  "scripts/check-doc-commands.mjs",
  "scripts/check-skips.mjs",
  "scripts/logs-prune.mjs",
  "scripts/tests-status.mjs",
  "scripts/gate-report.mjs",
];

function runHelp(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...args, "--help"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

describe("script entry points", () => {
  it(
    "every lane and CI script loads under its production loader",
    async () => {
      const runs = await Promise.all([
        ...TSX_ENTRYPOINTS.map(async (script) => ({ script, ...(await runHelp(["--import", "tsx", script])) })),
        ...NODE_ENTRYPOINTS.map(async (script) => ({ script, ...(await runHelp([script])) })),
      ]);
      const broken = runs.filter((run) => run.code !== 0 || !/usage|options/i.test(run.output));
      expect(
        broken.map((run) => `${run.script} (exit ${run.code}): ${run.output.slice(0, 400)}`),
      ).toEqual([]);
    },
    60_000,
  );
});
