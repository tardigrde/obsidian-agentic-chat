import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BudgetTracker,
  baselineRefusal,
  costUsd,
  gradeRun,
  summarizeCase,
  validateToolUseSuite,
  type ToolUseCase,
  type ToolUseCheck,
  type ToolUseSuite,
} from "../scripts/eval/tool-use-core";
import { extractPdfText } from "../src/retrieval/pdf-ingest";
import { MUTATING_TOOLS } from "../src/tools/tool-contracts";

const SUITE_PATH = path.join(process.cwd(), "test/evals/tool-use/tool-use.eval.json");
const CASE_IDS = [
  "none.arithmetic",
  "edit.find-and-edit",
  "rename.keep-links",
  "read.answer-from-note",
  "search.list-mentions",
  "write.create-from-inbox",
  "properties.set-status-and-tag",
  "delete.only-the-empty-one",
  "edit.append-under-heading",
  "ask.ambiguous-cleanup",
  "ignore.private-folder",
  "rename.move-tagged",
  "import.pdf-answer",
  "none.general-knowledge",
];
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function loadSuite(): ToolUseSuite {
  return validateToolUseSuite(JSON.parse(readFileSync(SUITE_PATH, "utf8")) as unknown);
}

function cloneSuite(): Record<string, unknown> {
  return JSON.parse(readFileSync(SUITE_PATH, "utf8")) as Record<string, unknown>;
}

function makeCase(
  checks: ToolUseCheck[],
  seedFiles: Record<string, string> = {},
): ToolUseCase {
  return { id: "test.case", prompt: "Do the task.", seed: { files: seedFiles, binaryFiles: {} }, checks };
}

async function grade(
  checks: ToolUseCheck[],
  observed: {
    files?: Record<string, string>;
    frontmatter?: Record<string, Record<string, unknown>>;
    links?: Record<string, string[]>;
    toolCalls?: Array<{ name: string; isError?: boolean }>;
    answer?: string;
  },
  seedFiles: Record<string, string> = {},
) {
  return gradeRun(makeCase(checks, seedFiles), {
    files: observed.files ?? {},
    frontmatter: observed.frontmatter ?? {},
    links: observed.links ?? {},
    toolCalls: observed.toolCalls ?? [],
    answer: observed.answer ?? "",
  });
}

function checkByType(result: { checks: Array<{ type: string; ok: boolean; detail: string }> }, type: string) {
  const check = result.checks.find((entry) => entry.type === type);
  if (!check) throw new Error(`missing ${type} check result`);
  return check;
}

describe("tool-use eval core", () => {
  it("accepts the committed suite", () => {
    const suite = loadSuite();
    expect(suite.name).toBe("tool-use");
    expect(suite.cases.map((entry) => entry.id)).toEqual(CASE_IDS);
  });

  it("reports each suite validation problem", () => {
    const cases: Array<{ mutate: (suite: Record<string, unknown>) => void; pattern: RegExp }> = [
      {
        mutate: (suite) => {
          suite.model = "openrouter/auto";
        },
        pattern: /suite\.model must be one of/,
      },
      {
        mutate: (suite) => {
          suite.runsPerCase = 0;
        },
        pattern: /runsPerCase must be an integer of at least 1/,
      },
      {
        mutate: (suite) => {
          const entries = suite.cases as Array<Record<string, unknown>>;
          entries[1].id = entries[0].id;
        },
        pattern: /Duplicate tool-use case id/,
      },
      {
        mutate: (suite) => {
          const entries = suite.cases as Array<Record<string, unknown>>;
          (entries[0].checks as Array<Record<string, unknown>>)[0].type = "not_a_check";
        },
        pattern: /Unknown check type/,
      },
      {
        mutate: (suite) => {
          const entries = suite.cases as Array<Record<string, unknown>>;
          delete (entries[0].checks as Array<Record<string, unknown>>)[0].text;
        },
        pattern: /checks\[0\]\.text must be a non-empty string/,
      },
      {
        mutate: (suite) => {
          const entries = suite.cases as Array<Record<string, unknown>>;
          entries[0].id = ".";
        },
        pattern: /cases\[0\]\.id must match/,
      },
      {
        mutate: (suite) => {
          const entries = suite.cases as Array<Record<string, unknown>>;
          entries[0].id = "..";
        },
        pattern: /cases\[0\]\.id must match/,
      },
      {
        mutate: (suite) => {
          const entries = suite.cases as Array<Record<string, unknown>>;
          entries[0].id = "Upper.Case";
        },
        pattern: /cases\[0\]\.id must match/,
      },
      {
        mutate: (suite) => {
          const entries = suite.cases as Array<Record<string, unknown>>;
          (entries[0].seed as { files: Record<string, string> }).files = { "../../escape.md": "x" };
        },
        pattern: /seed\.files\..* must be a vault-relative path/,
      },
      {
        mutate: (suite) => {
          const entries = suite.cases as Array<Record<string, unknown>>;
          (entries[0].seed as { files: Record<string, string> }).files = { "/absolute.md": "x" };
        },
        pattern: /seed\.files\..* must be a vault-relative path/,
      },
      {
        mutate: (suite) => {
          const entries = suite.cases as Array<Record<string, unknown>>;
          (entries[0].seed as { files: Record<string, string> }).files = { ".obsidian/app.json": "{}" };
        },
        pattern: /seed\.files\..* must be a vault-relative path/,
      },
      {
        mutate: (suite) => {
          const entries = suite.cases as Array<Record<string, unknown>>;
          (entries[0].seed as { files: Record<string, string> }).files = { "a\\b.md": "x" };
        },
        pattern: /seed\.files\..* must be a vault-relative path/,
      },
    ];

    for (const entry of cases) {
      const suite = cloneSuite();
      entry.mutate(suite);
      expect(() => validateToolUseSuite(suite)).toThrow(entry.pattern);
    }
  });

  it("accepts binary seed files and keeps them off the text seed", () => {
    const suite = cloneSuite();
    const entries = suite.cases as Array<Record<string, unknown>>;
    (entries[0].seed as Record<string, unknown>).binaryFiles = { "Docs/a.pdf": "JVBE" };

    const parsed = validateToolUseSuite(suite);

    expect(parsed.cases[0].seed.binaryFiles).toEqual({ "Docs/a.pdf": "JVBE" });
    expect(parsed.cases[0].seed.files).toEqual({});
    expect(loadSuite().cases[0].seed.binaryFiles).toEqual({});
  });

  it("rejects a seed path that is both text and binary", () => {
    const suite = cloneSuite();
    const entries = suite.cases as Array<Record<string, unknown>>;
    const seed = entries[0].seed as Record<string, unknown>;
    seed.files = { "Docs/a.pdf": "x" };
    seed.binaryFiles = { "Docs/a.pdf": "JVBE" };

    expect(() => validateToolUseSuite(suite)).toThrow(/is also a seed\.files entry/);
  });

  it("applies the seed path rules to binary files", () => {
    const cases: Array<{ binaryFiles: Record<string, unknown>; pattern: RegExp }> = [
      { binaryFiles: { "../escape.pdf": "JVBE" }, pattern: /seed\.binaryFiles\..* must be a vault-relative path/ },
      { binaryFiles: { "/absolute.pdf": "JVBE" }, pattern: /seed\.binaryFiles\..* must be a vault-relative path/ },
      { binaryFiles: { ".obsidian/a.pdf": "JVBE" }, pattern: /seed\.binaryFiles\..* must be a vault-relative path/ },
      { binaryFiles: { "a.pdf": 42 }, pattern: /must be a base64 string/ },
    ];

    for (const entry of cases) {
      const suite = cloneSuite();
      const seed = (suite.cases as Array<Record<string, unknown>>)[0].seed as Record<string, unknown>;
      seed.binaryFiles = entry.binaryFiles;
      expect(() => validateToolUseSuite(suite)).toThrow(entry.pattern);
    }
  });

  it("reads the seeded invoice PDF from base64", () => {
    const pdfCase = loadSuite().cases.find((entry) => entry.id === "import.pdf-answer");
    if (!pdfCase) throw new Error("missing import.pdf-answer");
    const base64 = pdfCase.seed.binaryFiles["Docs/invoice.pdf"];
    expect(base64).toBeTruthy();

    const bytes = Buffer.from(base64.replace(/\s+/g, ""), "base64");
    const extracted = extractPdfText(new Uint8Array(bytes));

    expect(extracted.text).toContain("Invoice total: 4,210 EUR");
    expect(extracted.pageCount).toBe(1);
  });

  it("grades file_exists and file_absent", async () => {
    const result = await grade(
      [
        { type: "file_exists", path: "Note.md" },
        { type: "file_absent", path: "Gone.md" },
        { type: "file_exists", path: "Missing.md" },
        { type: "file_absent", path: "Note.md" },
      ],
      { files: { "Note.md": "body" } },
    );

    expect(result.checks.map((check) => [check.type, check.ok])).toEqual([
      ["file_exists", true],
      ["file_absent", true],
      ["file_exists", false],
      ["file_absent", false],
    ]);
  });

  it("grades file_contains and file_not_contains, plain and regex", async () => {
    const result = await grade(
      [
        { type: "file_contains", path: "Note.md", text: "alpha" },
        { type: "file_contains", path: "Note.md", text: "gamma" },
        { type: "file_contains", path: "Note.md", text: "a.+a", regex: true },
        { type: "file_not_contains", path: "Note.md", text: "gamma" },
        { type: "file_not_contains", path: "Note.md", text: "alpha" },
        { type: "file_not_contains", path: "Missing.md", text: "alpha" },
      ],
      { files: { "Note.md": "alpha beta" } },
    );

    expect(result.checks.map((check) => check.ok)).toEqual([true, false, true, true, false, true]);
  });

  it("grades frontmatter scalars and arrays from the observed cache", async () => {
    const result = await grade(
      [
        { type: "frontmatter_equals", path: "Note.md", key: "tags", value: ["alpha"] },
        { type: "frontmatter_equals", path: "Note.md", key: "tags", value: ["alpha", "beta"] },
        { type: "frontmatter_equals", path: "Note.md", key: "tags", value: ["alpha", "gamma"] },
        { type: "frontmatter_equals", path: "Note.md", key: "count", value: 3 },
        { type: "frontmatter_equals", path: "Note.md", key: "published", value: true },
        { type: "frontmatter_equals", path: "Note.md", key: "name", value: "Atlas" },
        { type: "frontmatter_equals", path: "Note.md", key: "missing", value: "x" },
      ],
      {
        frontmatter: {
          "Note.md": { tags: ["alpha", "beta"], count: 3, published: true, name: "Atlas" },
        },
      },
    );

    expect(result.checks.map((check) => check.ok)).toEqual([true, true, false, true, true, true, false]);
  });

  it("supports exact frontmatter array equality", async () => {
    const result = await grade(
      [
        { type: "frontmatter_equals", path: "Note.md", key: "tags", value: ["alpha", "beta"], exact: true },
        { type: "frontmatter_equals", path: "Note.md", key: "tags", value: ["beta", "alpha"], exact: true },
        { type: "frontmatter_equals", path: "Note.md", key: "tags", value: ["alpha"], exact: true },
        { type: "frontmatter_equals", path: "Note.md", key: "tags", value: ["alpha", "beta"] },
      ],
      { frontmatter: { "Note.md": { tags: ["alpha", "beta"] } } },
    );

    expect(result.checks.map((check) => check.ok)).toEqual([true, true, false, true]);
  });

  it("grades unchanged against the seed", async () => {
    const seed = { "Keep.md": "stable", "Edit.md": "before" };
    const result = await grade(
      [
        { type: "unchanged", path: "Keep.md" },
        { type: "unchanged", path: "Edit.md" },
        { type: "unchanged", path: "NotSeeded.md" },
      ],
      { files: { "Keep.md": "stable", "Edit.md": "after" } },
      seed,
    );

    expect(result.checks.map((check) => check.ok)).toEqual([true, false, false]);
  });

  it("grades link_resolves against the resolved link targets", async () => {
    const result = await grade(
      [
        { type: "link_resolves", from: "Index.md", to: "Projects/Atlas Launch.md" },
        { type: "link_resolves", from: "Missing.md", to: "Projects/Atlas Launch.md" },
        { type: "link_resolves", from: "Index.md", to: "Projects/Other.md" },
      ],
      { links: { "Index.md": ["Projects/Atlas Launch.md", "Projects/Borealis.md"] } },
    );

    expect(result.checks.map((check) => check.ok)).toEqual([true, false, false]);
  });

  it("grades tool_called, tool_not_called, and the mutating wildcard", async () => {
    const toolCalls = [{ name: "edit" }, { name: "read" }, { name: "edit" }];
    const result = await grade(
      [
        { type: "tool_called", name: "edit" },
        { type: "tool_called", name: "edit", min: 2 },
        { type: "tool_called", name: "edit", min: 3 },
        { type: "tool_called", name: "*mutating*" },
        { type: "tool_not_called", name: "write" },
        { type: "tool_not_called", name: "*mutating*" },
        { type: "tool_called", name: "delete" },
      ],
      { toolCalls },
    );

    expect(result.checks.map((check) => check.ok)).toEqual([true, true, false, true, true, false, false]);
  });

  it("treats every product mutating tool as mutating in the wildcard", async () => {
    const toolCalls = [...MUTATING_TOOLS].map((name) => ({ name }));
    const result = await grade(
      [{ type: "tool_called", name: "*mutating*", min: MUTATING_TOOLS.size }],
      { toolCalls },
    );

    expect(MUTATING_TOOLS.size).toBeGreaterThan(0);
    expect(checkByType(result, "tool_called").ok).toBe(true);
  });

  it("grades max_tool_calls and no_tool_errors", async () => {
    const result = await grade(
      [
        { type: "max_tool_calls", max: 2 },
        { type: "max_tool_calls", max: 3 },
        { type: "no_tool_errors" },
      ],
      { toolCalls: [{ name: "read" }, { name: "edit" }, { name: "read" }] },
    );
    expect(result.checks.map((check) => check.ok)).toEqual([false, true, true]);

    const withError = await grade(
      [{ type: "no_tool_errors" }],
      { toolCalls: [{ name: "edit", isError: true }] },
    );
    expect(checkByType(withError, "no_tool_errors").ok).toBe(false);
  });

  it("grades answer_contains and answer_not_contains, plain and regex", async () => {
    const result = await grade(
      [
        { type: "answer_contains", text: "51" },
        { type: "answer_contains", text: "^51$" },
        { type: "answer_contains", text: "^51$", regex: true },
        { type: "answer_not_contains", text: "52" },
        { type: "answer_not_contains", text: "51" },
        { type: "answer_not_contains", text: "\\d+", regex: true },
      ],
      { answer: "51" },
    );

    expect(result.checks.map((check) => check.ok)).toEqual([true, false, true, true, false, false]);
  });

  it("requires the arithmetic case to answer exactly 51", () => {
    const suite = loadSuite();
    const arithmetic = suite.cases.find((entry) => entry.id === "none.arithmetic");
    if (!arithmetic) throw new Error("missing none.arithmetic case");
    const gradeAnswer = (answer: string) =>
      gradeRun(arithmetic, { files: {}, frontmatter: {}, links: {}, toolCalls: [], answer });

    expect(gradeAnswer("151").ok).toBe(false);
    expect(gradeAnswer("51.").ok).toBe(true);
    expect(gradeAnswer("The answer is 51").ok).toBe(true);
  });

  it("grades the rename case by resolved links, not link text", () => {
    const suite = loadSuite();
    const rename = suite.cases.find((entry) => entry.id === "rename.keep-links");
    if (!rename) throw new Error("missing rename.keep-links case");
    const files = {
      "Projects/Atlas Launch.md": "# Atlas\n",
      "Index.md": "# Index\n\n- [[Wrong/Atlas Launch]]\n",
      "Weekly.md": "# Weekly\n\nSee [[Wrong/Atlas Launch|the Atlas project]].\n",
    };
    const observed = {
      files,
      frontmatter: {},
      toolCalls: [{ name: "rename" }],
      answer: "",
      links: {
        "Index.md": ["Wrong/Atlas Launch.md"],
        "Weekly.md": ["Wrong/Atlas Launch.md"],
      },
    };

    expect(gradeRun(rename, observed).ok).toBe(false);
    expect(
      gradeRun(rename, {
        ...observed,
        links: {
          "Index.md": ["Projects/Atlas Launch.md"],
          "Weekly.md": ["Projects/Atlas Launch.md"],
        },
      }).ok,
    ).toBe(true);
  });

  it("uses regex flags for answer and file checks", async () => {
    const result = await grade(
      [
        { type: "answer_contains", text: "VENDOR", regex: true, flags: "i" },
        { type: "answer_contains", text: "VENDOR", regex: true },
        { type: "answer_not_contains", text: "VENDOR", regex: true, flags: "i" },
        { type: "file_contains", path: "Note.md", text: "ALPHA", regex: true, flags: "i" },
        { type: "file_not_contains", path: "Note.md", text: "ALPHA", regex: true, flags: "i" },
      ],
      { answer: "The vendor may slip.", files: { "Note.md": "alpha beta" } },
    );

    expect(result.checks.map((check) => check.ok)).toEqual([true, false, false, true, false]);
  });

  it("reports invalid regex flags", () => {
    const suite = cloneSuite();
    const checks = (suite.cases as Array<Record<string, unknown>>)[0].checks as Array<Record<string, unknown>>;
    checks.push({ type: "answer_contains", text: "x", regex: true, flags: "zz" });

    expect(() => validateToolUseSuite(suite)).toThrow(/flags is not a valid regular expression flag set/);
  });

  it("fails the whole run when any check fails", async () => {
    const result = await grade(
      [
        { type: "file_exists", path: "Note.md" },
        { type: "answer_contains", text: "nope" },
      ],
      { files: { "Note.md": "body" }, answer: "yes" },
    );

    expect(result.ok).toBe(false);
    expect(checkByType(result, "file_exists").detail).toContain("found Note.md");
    expect(checkByType(result, "answer_contains").detail).toContain("does not contain");
  });

  it("computes cost from input, output, and cache-read tokens", () => {
    const usd = costUsd(
      { input: 1_000, output: 500, cacheRead: 200 },
      { input: 0.000001, output: 0.000002, cacheRead: 0.0000005 },
    );
    expect(usd).toBeCloseTo(0.0021, 10);
  });

  it("includes cache-write tokens in cost", () => {
    const usd = costUsd(
      { input: 1_000, output: 500, cacheRead: 200, cacheWrite: 100 },
      { input: 0.000001, output: 0.000002, cacheRead: 0.0000005, cacheWrite: 0.0000002 },
    );
    expect(usd).toBeCloseTo(0.00212, 10);
  });

  it("stops on each budget cap", () => {
    const pricing = { input: 1, output: 0, cacheRead: 0 };

    const usd = new BudgetTracker({ maxUsd: 0.5, maxModelCalls: 100, maxTokens: 100_000 }, pricing);
    usd.add({ usage: { input: 1 } });
    expect(usd.exceeded()).toContain("maxUsd");

    const calls = new BudgetTracker({ maxUsd: 100, maxModelCalls: 2, maxTokens: 100_000 }, pricing);
    calls.add({ usage: { input: 0 }, modelCalls: 2 });
    expect(calls.exceeded()).toContain("maxModelCalls");

    const tokens = new BudgetTracker({ maxUsd: 100, maxModelCalls: 100, maxTokens: 10 }, pricing);
    tokens.add({ usage: { totalTokens: 10 } });
    expect(tokens.exceeded()).toContain("maxTokens");

    const clear = new BudgetTracker({ maxUsd: 100, maxModelCalls: 100, maxTokens: 100 }, pricing);
    clear.add({ usage: { input: 1 }, modelCalls: 1 });
    expect(clear.exceeded()).toBeNull();
  });

  it("summarizes pass rate, tokens, USD, and time", () => {
    const summary = summarizeCase([
      { status: "pass", usage: { totalTokens: 100 }, usd: 0.01, ms: 1_000 },
      { status: "fail", usage: { totalTokens: 200 }, usd: 0.02, ms: 3_000 },
      { status: "skipped-budget", usage: {}, usd: 0, ms: 0 },
    ]);

    expect(summary).toMatchObject({
      runs: 3,
      executed: 2,
      passed: 1,
      skipped: 1,
      passRate: 0.5,
      meanTokens: 150,
      maxTokens: 200,
      totalUsd: 0.03,
      meanUsd: 0.015,
      meanMs: 2_000,
    });
  });

  describe("baseline refusal", () => {
    const suite = { runsPerCase: 2, cases: [{ id: "case.one" }] };
    const summary = (
      runs: Array<{ status: string; error?: string }>,
      options: { budgetExceeded?: string | null; caseId?: string } = {},
    ) => ({
      budget: { exceeded: options.budgetExceeded ?? null },
      cases: [{ id: options.caseId ?? "case.one", runResults: runs }],
    });
    const refusal = (
      input: ReturnType<typeof summary>,
      plannedRunCount: number,
      activeSuite: typeof suite = suite,
    ) => baselineRefusal(input, plannedRunCount, activeSuite) ?? "";

    it("refuses a run skipped by the budget", () => {
      const input = summary([{ status: "pass" }, { status: "skipped-budget" }]);
      expect(refusal(input, 2)).toMatch(/skipped by the budget/);
    });

    it("refuses a run with a harness error", () => {
      const input = summary([{ status: "pass" }, { status: "fail", error: "boom" }]);
      expect(refusal(input, 2)).toMatch(/harness error/);
    });

    it("refuses a missing planned run", () => {
      const input = summary([{ status: "pass" }]);
      expect(refusal(input, 2)).toMatch(/planned run/);
    });

    it("refuses a run that exceeded the budget", () => {
      const input = summary([{ status: "pass" }, { status: "fail" }], {
        budgetExceeded: "maxUsd (spent, cap)",
      });
      expect(refusal(input, 2)).toMatch(/budget was exceeded/);
    });

    it("refuses a run that does not cover every case at runsPerCase", () => {
      const partial = summary([{ status: "pass" }]);
      expect(refusal(partial, 1)).toMatch(/baseline needs every/);

      const subset = summary([{ status: "pass" }, { status: "pass" }]);
      expect(
        refusal(subset, 2, {
          runsPerCase: 2,
          cases: [{ id: "case.one" }, { id: "case.two" }],
        }),
      ).toMatch(/did not cover every suite case/);
    });

    it("accepts a complete run even when checks failed", () => {
      const input = summary([{ status: "pass" }, { status: "fail" }]);
      expect(baselineRefusal(input, 2, suite)).toBeNull();
    });
  });

  it("extracts tool calls, usage, and the final answer from session text", async () => {
    const analyzer = (await import(
      pathToFileURL(path.join(process.cwd(), "scripts/analyze-session-trace.mjs")).href
    )) as {
      analyzeSessionText: (text: string) => {
        files: Array<{ toolCalls: Array<{ name: string; isError: boolean }>; finalAssistantText: string }>;
        aggregate: { usage: { totalTokens: number } };
      };
    };
    const text = [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Update the note." }] },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 20, output: 10, totalTokens: 30 },
          content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: {} }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "edit",
          isError: false,
          content: [{ type: "text", text: "ok" }],
        },
      },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    const result = analyzer.analyzeSessionText(text);
    expect(result.files[0].toolCalls).toEqual([{ name: "edit", isError: false, toolCallId: "call-1" }]);
    expect(result.files[0].finalAssistantText).toBe("Done.");
    expect(result.aggregate.usage.totalTokens).toBe(30);
  });

  it("refuses to reuse a results directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tool-use-reuse-"));
    tempRoots.push(root);
    const caseDir = path.join(root, "results", "none.arithmetic");
    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "1.json"), "{}\n");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/run-tool-use-evals.ts",
        "--run-id",
        "reused",
        "--out-dir",
        root,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, AGENTIC_CHAT_API_KEY: "" },
      },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("run id already used; pick a new --run-id");
  });

  it("flags tool results and audit end events that report errors", async () => {
    const analyzer = (await import(
      pathToFileURL(path.join(process.cwd(), "scripts/analyze-session-trace.mjs")).href
    )) as {
      analyzeSessionText: (text: string) => {
        files: Array<{ toolCalls: Array<{ name: string; isError: boolean }> }>;
      };
    };
    const text = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-edit", name: "edit", arguments: {} },
            { type: "toolCall", id: "call-write", name: "write", arguments: {} },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-edit",
          toolName: "edit",
          isError: true,
          content: [{ type: "text", text: "edit failed" }],
        },
      },
      {
        type: "action_audit",
        event: {
          category: "tool_call",
          action: "end",
          isError: true,
          toolName: "write",
          toolCallId: "call-write",
        },
      },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Failed." }] } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    const calls = analyzer.analyzeSessionText(text).files[0].toolCalls;
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "edit", isError: true }),
        expect.objectContaining({ name: "write", isError: true }),
      ]),
    );
  });

  it("prints a dry-run plan without network or output files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tool-use-dry-"));
    tempRoots.push(root);
    const outputDir = path.join(root, "out");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/run-tool-use-evals.ts",
        "--dry-run",
        "--run-id",
        "dry-test",
        "--out-dir",
        outputDir,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("14 case(s) x 3 run(s)");
    for (const id of CASE_IDS) expect(result.stdout).toContain(`- ${id}:`);
    expect(result.stdout).toContain("prices: not fetched (dry run)");
    expect(result.stdout).toContain("estimated cost");
    expect(result.stdout).toContain("15k tokens/run");
    expect(existsSync(outputDir)).toBe(false);
  });
});
