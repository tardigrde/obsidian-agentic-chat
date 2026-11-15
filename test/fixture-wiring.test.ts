import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolUseCase } from "../scripts/eval/tool-use-core";
import { expandFixturePlaceholders, needsFixture } from "../scripts/run-tool-use-evals";

const CORE_SUITE_PATH = path.join(process.cwd(), "test/evals/tool-use/core.eval.json");
const FIXTURE_MARKER = ", fixture server";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** Run the existing dry-run path: no key, no network, no output files. */
function runDryRun(suitePath: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/run-tool-use-evals.ts", "--suite", suitePath, "--dry-run"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, AGENTIC_CHAT_API_KEY: "", AGENTIC_CHAT_THINKING_LEVEL: "" },
    },
  );
}

/** A one-case suite that reuses the core suite's model, budget, and turn limits. */
async function writeSuite(evalCase: Record<string, unknown>): Promise<string> {
  const base = JSON.parse(readFileSync(CORE_SUITE_PATH, "utf8")) as Record<string, unknown>;
  const root = await mkdtemp(path.join(tmpdir(), "fixture-wiring-"));
  tempRoots.push(root);
  const suitePath = path.join(root, "fixture-wiring.eval.json");
  const suite = { ...base, name: "fixture-wiring", runsPerCase: 1, cases: [evalCase] };
  await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
  return suitePath;
}

function webCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "web.easy.article",
    prompt: "Read {{fixture}}/article and report the published date.",
    seed: { files: {} },
    checks: [{ type: "answer_contains", text: "2026-01-05" }],
    ...overrides,
  };
}

function makeCase(overrides: Partial<ToolUseCase> = {}): ToolUseCase {
  return {
    id: "web.easy.article",
    prompt: "Read {{fixture}}/article and report the published date.",
    seed: { files: {}, binaryFiles: {} },
    checks: [],
    ...overrides,
  };
}

describe("fixture helpers", () => {
  it("replaces every placeholder with the base URL", () => {
    const [expanded] = expandFixturePlaceholders(
      [makeCase({ prompt: "Compare {{fixture}}/article with {{fixture}}/article-v2." })],
      "http://127.0.0.1:4321",
    );

    expect(expanded.prompt).toBe("Compare http://127.0.0.1:4321/article with http://127.0.0.1:4321/article-v2.");
  });

  it("returns a case without a placeholder unchanged", () => {
    const original = makeCase({ prompt: "Answer from the vault only." });

    const [expanded] = expandFixturePlaceholders([original], "http://127.0.0.1:4321");

    expect(expanded).toBe(original);
  });

  it("refuses a placeholder prompt when no base URL is available", () => {
    const evalCase = makeCase({ id: "web.hard.missing", prompt: "Fetch {{fixture}}/article." });

    expect(() => expandFixturePlaceholders([evalCase], undefined)).toThrow(
      /Case web\.hard\.missing uses \{\{fixture\}\} in its prompt, but no fixture server base URL is available\./,
    );
  });

  it("detects a placeholder prompt and an opted-in web setting", () => {
    expect(needsFixture([makeCase()])).toBe(true);
    expect(needsFixture([makeCase({ prompt: "plain", settings: { "web.enabled": true } })])).toBe(true);
    expect(needsFixture([makeCase({ prompt: "plain", settings: { "web.enabled": false } })])).toBe(false);
    expect(needsFixture([makeCase({ prompt: "plain", settings: { ignoredGlobs: "" } })])).toBe(false);
    expect(needsFixture([])).toBe(false);
  });
});

describe("fixture wiring in the tool-use runner", () => {
  it("marks a case with a {{fixture}} prompt as needing the fixture server", async () => {
    const suitePath = await writeSuite(webCase());

    const result = runDryRun(suitePath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`- web.easy.article: 1 run(s), 0 seed file(s)${FIXTURE_MARKER}`);
  });

  it("marks a case that enables web access as needing the fixture server", async () => {
    const suitePath = await writeSuite(
      webCase({ prompt: "Fetch the article I saved and report its published date.", settings: { "web.enabled": true } }),
    );

    const result = runDryRun(suitePath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`- web.easy.article: 1 run(s), 0 seed file(s)${FIXTURE_MARKER}`);
  });

  it("marks only tools.medium.web in the core dry-run plan", () => {
    const result = runDryRun(CORE_SUITE_PATH);

    expect(result.status, result.stderr).toBe(0);
    const caseLines = result.stdout.split("\n").filter((line) => line.startsWith("- "));
    expect(caseLines).toHaveLength(25);
    const webLine = caseLines.find((line) => line.startsWith("- tools.medium.web: "));
    expect(webLine, "tools.medium.web must be in the core dry run").toBeDefined();
    expect(webLine).toContain(FIXTURE_MARKER);
    expect(caseLines.filter((line) => line.includes(FIXTURE_MARKER))).toEqual([webLine]);
  });
});
