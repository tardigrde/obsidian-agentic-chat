import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const RUNNER_PATH = path.join(process.cwd(), "scripts/run-tool-use-evals.ts");
const CORE_SUITE_PATH = path.join(process.cwd(), "test/evals/tool-use/core.eval.json");

/** One core case per category, in the order the smoke slice runs them. */
const EXPECTED_SMOKE_IDS = [
  "find.hard.venue",
  "edit.hard.status",
  "organize.medium.inbox",
  "create.medium.summary",
  "properties.hard.owners",
  "tools.easy.search",
  "safety.medium.injection",
  "recovery.medium.stale",
];
const CATEGORIES = ["find", "edit", "organize", "create", "properties", "tools", "safety", "recovery"];

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function runRunner(argv: string[], suitePath = CORE_SUITE_PATH) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/run-tool-use-evals.ts", "--suite", suitePath, ...argv],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, AGENTIC_CHAT_API_KEY: "" },
    },
  );
}

/** Read the planned case ids from the dry-run plan, not from the source. */
function plannedCaseIds(stdout: string): string[] {
  return [...stdout.matchAll(/^- ([a-z0-9.-]+): \d+ run\(s\),/gm)].map((match) => match[1]);
}

function coreSuiteCaseIds(): string[] {
  const suite = JSON.parse(readFileSync(CORE_SUITE_PATH, "utf8")) as { cases: Array<{ id: string }> };
  return suite.cases.map((entry) => entry.id);
}

async function smokeCaseIdsFromModule(): Promise<{ status: number | null; stderr: string; ids: unknown }> {
  const script = [
    `const module = await import(${JSON.stringify(pathToFileURL(RUNNER_PATH).href)});`,
    "console.log(JSON.stringify(module.SMOKE_CASE_IDS));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, AGENTIC_CHAT_API_KEY: "" },
  });
  let ids: unknown;
  try {
    ids = JSON.parse(result.stdout.trim());
  } catch {
    ids = undefined;
  }
  return { status: result.status, stderr: result.stderr, ids };
}

describe("tool-use smoke slice", () => {
  it("plans the eight smoke cases in one run", () => {
    const result = runRunner(["--smoke", "--dry-run"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("8 case(s) x 1 run(s) = 8 run(s)");
    expect(plannedCaseIds(result.stdout)).toEqual(EXPECTED_SMOKE_IDS);
  });

  it("covers one core case per category, and every id exists in the core suite", () => {
    const result = runRunner(["--smoke", "--dry-run"]);

    expect(result.status, result.stderr).toBe(0);
    const ids = plannedCaseIds(result.stdout);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(ids.map((id) => id.split(".")[0])).toEqual(CATEGORIES);

    const suiteIds = new Set(coreSuiteCaseIds());
    for (const id of ids) expect(suiteIds.has(id), `${id} is not in the core suite`).toBe(true);
  });

  it("honors an explicit --runs over the one-run smoke default", () => {
    const result = runRunner(["--smoke", "--runs", "2", "--dry-run"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("8 case(s) x 2 run(s) = 16 run(s)");
    expect(plannedCaseIds(result.stdout)).toEqual(EXPECTED_SMOKE_IDS);
  });

  it("refuses --smoke together with --case", () => {
    const result = runRunner(["--smoke", "--case", "read.answer-from-note", "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--smoke cannot be combined with --case/);
  });

  it("fails with the missing id when the suite lacks a smoke case", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tool-use-smoke-"));
    tempRoots.push(root);
    const missing = "safety.medium.injection";
    const suite = JSON.parse(readFileSync(CORE_SUITE_PATH, "utf8")) as { cases: Array<{ id: string }> };
    suite.cases = suite.cases.filter((entry) => entry.id !== missing);
    const suitePath = path.join(root, "core-without-a-smoke-case.eval.json");
    await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");

    const result = runRunner(["--smoke", "--dry-run"], suitePath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(missing);
  });

  it("exports SMOKE_CASE_IDS for the test and the docs", async () => {
    const result = await smokeCaseIdsFromModule();

    expect(result.status, result.stderr).toBe(0);
    expect(result.ids).toEqual(EXPECTED_SMOKE_IDS);
  });
});
