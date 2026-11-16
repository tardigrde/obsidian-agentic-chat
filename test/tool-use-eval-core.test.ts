import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BudgetTracker,
  TOOL_USE_THINKING_LEVELS,
  baselineRefusal,
  costUsd,
  effectiveThinkingLevel,
  gradeRun,
  resolveThinkingLevel,
  summarizeCase,
  summarizeOverall,
  validateToolUseSuite,
  type CaseRunSummaryInput,
  type ToolUseCase,
  type ToolUseCheck,
  type ToolUseSuite,
} from "../scripts/eval/tool-use-core";
import { extractPdfText } from "../src/retrieval/pdf-ingest";
import { THINKING_LEVELS } from "../src/settings-schema";
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
    unresolvedLinks?: Record<string, string[]>;
    toolCalls?: Array<{ name: string; isError?: boolean }>;
    answer?: string;
  },
  seedFiles: Record<string, string> = {},
) {
  return gradeRun(makeCase(checks, seedFiles), {
    files: observed.files ?? {},
    frontmatter: observed.frontmatter ?? {},
    links: observed.links ?? {},
    unresolvedLinks: observed.unresolvedLinks ?? {},
    toolCalls: observed.toolCalls ?? [],
    answer: observed.answer ?? "",
  });
}

function checkByType(result: { checks: Array<{ type: string; ok: boolean; detail: string }> }, type: string) {
  const check = result.checks.find((entry) => entry.type === type);
  if (!check) throw new Error(`missing ${type} check result`);
  return check;
}

function runSummary(overrides: Partial<CaseRunSummaryInput> = {}): CaseRunSummaryInput {
  return {
    status: "pass",
    usage: { totalTokens: 100 },
    usd: 0.01,
    ms: 1_000,
    modelCalls: 2,
    toolCalls: 3,
    partialScore: 1,
    ...overrides,
  };
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

  it("validates an optional generated vault seed", () => {
    const suite = cloneSuite();
    const seed = (suite.cases as Array<Record<string, unknown>>)[0].seed as Record<string, unknown>;
    seed.vault = { size: "S", seed: 7 };

    expect(validateToolUseSuite(suite).cases[0].seed.vault).toEqual({ size: "S", seed: 7 });

    const large = cloneSuite();
    ((large.cases as Array<Record<string, unknown>>)[0].seed as Record<string, unknown>).vault = { size: "L", seed: 3 };
    expect(validateToolUseSuite(large).cases[0].seed.vault).toEqual({ size: "L", seed: 3 });

    const invalid: Array<{ vault: unknown; pattern: RegExp }> = [
      { vault: "S", pattern: /seed\.vault must be an object/ },
      { vault: { size: "XL", seed: 1 }, pattern: /seed\.vault\.size must be "S", "M", or "L"/ },
      { vault: { size: "S" }, pattern: /seed\.vault\.seed must be a non-negative integer/ },
      { vault: { size: "S", seed: -1 }, pattern: /seed\.vault\.seed must be a non-negative integer/ },
      { vault: { size: "S", seed: 1.5 }, pattern: /seed\.vault\.seed must be a non-negative integer/ },
      { vault: { size: "S", seed: "7" }, pattern: /seed\.vault\.seed must be a non-negative integer/ },
    ];

    for (const entry of invalid) {
      const bad = cloneSuite();
      ((bad.cases as Array<Record<string, unknown>>)[0].seed as Record<string, unknown>).vault = entry.vault;
      expect(() => validateToolUseSuite(bad)).toThrow(entry.pattern);
    }
  });

  it("validates expected.maxToolCalls as a reporting budget", () => {
    const suite = cloneSuite();
    (suite.cases as Array<Record<string, unknown>>)[0].expected = { maxToolCalls: 3 };
    expect(validateToolUseSuite(suite).cases[0].expected).toEqual({ maxToolCalls: 3 });

    for (const value of [0, -1, 1.5, "3"]) {
      const bad = cloneSuite();
      (bad.cases as Array<Record<string, unknown>>)[0].expected = { maxToolCalls: value };
      expect(() => validateToolUseSuite(bad)).toThrow(/expected\.maxToolCalls must be a positive integer/);
    }

    const notObject = cloneSuite();
    (notObject.cases as Array<Record<string, unknown>>)[0].expected = 5;
    expect(() => validateToolUseSuite(notObject)).toThrow(/expected must be an object/);
  });

  describe("thinking level axis", () => {
    it("uses the same level list as the product", () => {
      expect([...TOOL_USE_THINKING_LEVELS]).toEqual(THINKING_LEVELS);
    });

    it("accepts a suite level and a per-case pin", () => {
      const suite = cloneSuite();
      suite.thinkingLevel = "low";
      (suite.cases as Array<Record<string, unknown>>)[0].thinkingLevel = "off";

      const parsed = validateToolUseSuite(suite);

      expect(parsed.thinkingLevel).toBe("low");
      expect(parsed.cases[0].thinkingLevel).toBe("off");
      expect(parsed.cases[1].thinkingLevel).toBeUndefined();
    });

    it("rejects an unknown suite or case level", () => {
      for (const value of ["none", "max", "LOW", 7, null]) {
        const badSuite = cloneSuite();
        badSuite.thinkingLevel = value;
        expect(() => validateToolUseSuite(badSuite)).toThrow(/suite\.thinkingLevel must be one of/);

        const badCase = cloneSuite();
        (badCase.cases as Array<Record<string, unknown>>)[0].thinkingLevel = value;
        expect(() => validateToolUseSuite(badCase)).toThrow(/cases\[0\]\.thinkingLevel must be one of/);
      }
    });

    it("resolves CLI over env over suite over the low default", () => {
      expect(resolveThinkingLevel({ cli: "off", env: "high", suite: "medium" })).toEqual({
        level: "off",
        source: "cli",
      });
      expect(resolveThinkingLevel({ env: "high", suite: "medium" })).toEqual({ level: "high", source: "env" });
      expect(resolveThinkingLevel({ suite: "medium" })).toEqual({ level: "medium", source: "suite" });
      expect(resolveThinkingLevel({})).toEqual({ level: "low", source: "default" });
    });

    it("names the bad source and the allowed levels", () => {
      expect(() => resolveThinkingLevel({ cli: "none" })).toThrow(
        /--thinking-level must be one of off, minimal, low, medium, high, xhigh; got "none"/,
      );
      expect(() => resolveThinkingLevel({ env: "max" })).toThrow(
        /AGENTIC_CHAT_THINKING_LEVEL must be one of off, minimal, low, medium, high, xhigh; got "max"/,
      );
    });

    it("lets a per-case pin win over the run level", () => {
      expect(effectiveThinkingLevel({ thinkingLevel: "off" }, "high")).toBe("off");
      expect(effectiveThinkingLevel({ thinkingLevel: "low" }, "high")).toBe("low");
      expect(effectiveThinkingLevel({}, "high")).toBe("high");
    });
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

  it("accepts a no_unresolved_links check", () => {
    const suite = cloneSuite();
    const checks = (suite.cases as Array<Record<string, unknown>>)[0].checks as Array<Record<string, unknown>>;
    checks.push({ type: "no_unresolved_links", path: "Index.md" });

    expect(() => validateToolUseSuite(suite)).not.toThrow();
  });

  it("grades no_unresolved_links against the observed unresolved links", async () => {
    const result = await grade(
      [
        { type: "no_unresolved_links", path: "Index.md" },
        { type: "no_unresolved_links", path: "Weekly.md" },
        { type: "no_unresolved_links", path: "Broken.md" },
      ],
      { unresolvedLinks: { "Weekly.md": ["Missing"], "Broken.md": ["Missing"] } },
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
      gradeRun(arithmetic, { files: {}, frontmatter: {}, links: {}, unresolvedLinks: {}, toolCalls: [], answer });

    expect(gradeAnswer("51").ok).toBe(true);
    expect(gradeAnswer("51.").ok).toBe(true);
    expect(gradeAnswer("The answer is 51").ok).toBe(true);
    // The prompt asks for the number only, so no other digits may follow.
    expect(gradeAnswer("51 (17 x 3)").ok).toBe(false);
    expect(gradeAnswer("51? No, 102.").ok).toBe(false);
    expect(gradeAnswer("151").ok).toBe(false);
    expect(gradeAnswer("-51").ok).toBe(false);
    expect(gradeAnswer("—51").ok).toBe(false);
    expect(gradeAnswer("510").ok).toBe(false);
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
      unresolvedLinks: {},
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

  it("accepts a clarifying question in plain text or through ask_user for the ambiguous cleanup", () => {
    const suite = loadSuite();
    const ask = suite.cases.find((entry) => entry.id === "ask.ambiguous-cleanup");
    if (!ask) throw new Error("missing ask.ambiguous-cleanup case");
    const files = ask.seed.files;
    const reads = [{ name: "vault_inspect" }, { name: "read" }];
    const run = (answer: string, toolCalls: Array<{ name: string }>) =>
      gradeRun(ask, { files, frontmatter: {}, links: {}, unresolvedLinks: {}, toolCalls, answer });

    expect(run("Here are some options.\n\nWhich direction do you want?", reads).ok).toBe(true);
    expect(run("Which direction do you want? I will wait for your answer.", reads).ok).toBe(true);
    expect(run("I don't want to guess.", [...reads, { name: "ask_user" }]).ok).toBe(true);
    expect(run("I will merge the meeting notes.", reads).ok).toBe(false);
    expect(run("Which one?", [...reads, { name: "delete" }]).ok).toBe(false);
    // A new plan note is a mutation too, even when every seed note is unchanged.
    expect(run("Which notes should I clean up?", [...reads, { name: "write" }]).ok).toBe(false);
  });

  it("rejects an any_of check with fewer than two inner checks", () => {
    const suite = cloneSuite();
    const checks = (suite.cases as Array<Record<string, unknown>>)[0].checks as Array<Record<string, unknown>>;
    checks.push({ type: "any_of", checks: [{ type: "no_tool_errors" }] });

    expect(() => validateToolUseSuite(suite)).toThrow(/at least 2 checks/);
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

  it("keeps pass@K at 1 only when every executed run passes", () => {
    expect(summarizeCase([runSummary(), runSummary()]).passAtK).toBe(1);
    expect(summarizeCase([runSummary(), runSummary({ status: "fail" })]).passAtK).toBe(0);
    expect(summarizeCase([runSummary(), runSummary({ status: "skipped-budget" })]).passAtK).toBe(1);
    expect(summarizeCase([]).passAtK).toBe(0);
  });

  it("takes the median of the executed run times", () => {
    expect(summarizeCase([runSummary({ ms: 5_000 }), runSummary({ ms: 1_000 }), runSummary({ ms: 3_000 })]).medianMs).toBe(3_000);
    expect(summarizeCase([runSummary({ ms: 1_000 }), runSummary({ ms: 3_000 })]).medianMs).toBe(2_000);
    expect(summarizeCase([runSummary({ ms: 1_000 }), runSummary({ ms: 9_000, status: "skipped-budget" })]).medianMs).toBe(1_000);
    expect(summarizeCase([]).medianMs).toBe(0);
  });

  it("means the share of checks that passed and scores no checks as 0", () => {
    expect(summarizeCase([runSummary({ partialScore: 1 }), runSummary({ partialScore: 0.5 })]).partialScore).toBe(0.75);
    expect(summarizeCase([runSummary({ partialScore: 0 })]).partialScore).toBe(0);
    expect(summarizeCase([runSummary({ partialScore: undefined })]).partialScore).toBe(0);
    expect(
      summarizeCase([runSummary({ partialScore: 1 }), runSummary({ partialScore: 0, status: "skipped-budget" })]).partialScore,
    ).toBe(1);
  });

  it("means model calls and tool calls over the executed runs", () => {
    const summary = summarizeCase([
      runSummary({ modelCalls: 1, toolCalls: 2 }),
      runSummary({ modelCalls: 3, toolCalls: 4 }),
      runSummary({ modelCalls: 9, toolCalls: 9, status: "skipped-budget" }),
    ]);

    expect(summary.meanModelCalls).toBe(2);
    expect(summary.meanToolCalls).toBe(3);
    expect(summarizeCase([]).meanModelCalls).toBe(0);
    expect(summarizeCase([]).meanToolCalls).toBe(0);
  });

  it("counts runs over the expected tool-call budget", () => {
    const runs = [runSummary({ toolCalls: 2 }), runSummary({ toolCalls: 5 }), runSummary({ toolCalls: 7 })];

    expect(summarizeCase(runs, { maxToolCalls: 6 }).overBudgetRuns).toBe(1);
    expect(summarizeCase(runs, { maxToolCalls: 2 }).overBudgetRuns).toBe(2);
    expect(summarizeCase(runs).overBudgetRuns).toBe(0);
    expect(
      summarizeCase([...runs, runSummary({ toolCalls: 99, status: "skipped-budget" })], { maxToolCalls: 2 }).overBudgetRuns,
    ).toBe(2);
  });

  it("aggregates the overall object from the per-case summaries", () => {
    const firstRuns = [runSummary({ status: "pass" }), runSummary({ status: "pass" })];
    const secondRuns = [runSummary({ status: "fail", partialScore: 0.5, usd: 0.02 })];
    const overall = summarizeOverall([
      { ...summarizeCase(firstRuns, { maxToolCalls: 2 }), runResults: firstRuns },
      { ...summarizeCase(secondRuns), runResults: secondRuns },
    ]);

    expect(overall).toMatchObject({
      cases: 2,
      runs: 3,
      passAtK: 0.5,
      meanPassAt1: 0.5,
      partialScore: 0.75,
      totalUsd: 0.04,
      meanTokens: 100,
      meanModelCalls: 2,
      meanToolCalls: 3,
      medianCaseMs: 1_000,
    });
    expect(overall.meanUsd).toBeCloseTo(0.04 / 3, 10);
  });

  it("keeps skipped runs out of the overall run metrics", () => {
    const runs = [runSummary({ status: "pass" }), runSummary({ status: "skipped-budget", usage: {}, usd: 0, ms: 0 })];
    const overall = summarizeOverall([{ ...summarizeCase(runs), runResults: runs }]);

    expect(overall.runs).toBe(1);
    expect(overall.meanUsd).toBeCloseTo(0.01, 10);
    expect(overall.meanTokens).toBe(100);
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

  it("compares overall metrics and flags cost, time, and pass regressions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tool-use-compare-"));
    tempRoots.push(root);
    const baselinePath = path.join(root, "baseline.json");
    const candidatePath = path.join(root, "candidate.json");
    const baseline = {
      thinkingLevel: "off",
      thinkingLevelSource: "suite",
      cases: [
        {
          id: "case.one",
          thinkingLevel: "off",
          observedThinkingLevels: ["off"],
          thinkingLevelMismatches: 0,
          passRate: 1,
          passAtK: 1,
          partialScore: 1,
          meanTokens: 1_000,
          meanUsd: 0.01,
          meanModelCalls: 2,
          meanToolCalls: 3,
          medianMs: 1_000,
        },
        {
          id: "case.two",
          thinkingLevel: "off",
          observedThinkingLevels: ["off"],
          thinkingLevelMismatches: 0,
          passRate: 0.5,
          passAtK: 0,
          partialScore: 0.75,
          meanTokens: 2_000,
          meanUsd: 0.02,
          meanModelCalls: 4,
          meanToolCalls: 6,
          medianMs: 4_000,
        },
      ],
      overall: {
        cases: 2,
        runs: 6,
        passAtK: 0.5,
        meanPassAt1: 0.75,
        partialScore: 0.875,
        totalUsd: 0.09,
        meanUsd: 0.015,
        meanTokens: 1_500,
        meanModelCalls: 3,
        meanToolCalls: 4.5,
        medianCaseMs: 2_500,
      },
    };
    const candidate = {
      thinkingLevel: "low",
      thinkingLevelSource: "cli",
      cases: [
        {
          id: "case.one",
          thinkingLevel: "low",
          observedThinkingLevels: ["high", "low"],
          thinkingLevelMismatches: 1,
          passRate: 0.75,
          passAtK: 0,
          partialScore: 0.8,
          meanTokens: 1_200,
          meanUsd: 0.016,
          meanModelCalls: 3,
          meanToolCalls: 5,
          medianMs: 2_500,
        },
        {
          id: "case.two",
          thinkingLevel: "low",
          observedThinkingLevels: ["low"],
          thinkingLevelMismatches: 0,
          passRate: 0.5,
          passAtK: 0,
          partialScore: 0.7,
          meanTokens: 1_900,
          meanUsd: 0.02,
          meanModelCalls: 4,
          meanToolCalls: 6,
          medianMs: 4_000,
        },
      ],
      overall: {
        cases: 2,
        runs: 6,
        passAtK: 0,
        meanPassAt1: 0.625,
        partialScore: 0.75,
        totalUsd: 0.108,
        meanUsd: 0.018,
        meanTokens: 1_550,
        meanModelCalls: 3.5,
        meanToolCalls: 5.5,
        medianCaseMs: 3_250,
      },
    };
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/run-tool-use-evals.ts", "--compare", baselinePath, candidatePath],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("- Baseline: (suite?), (model?), thinking off (suite)");
    expect(result.stdout).toContain("- Candidate: (suite?), (model?), thinking low (cli)");
    expect(result.stdout).toContain("| Case | Thinking | Pass rate |");
    expect(result.stdout).toContain("off (observed off) -> low (observed high!, low; 1 mismatch(es))");
    expect(result.stdout).toContain("| pass^K | 50% | 0% | -50% |");
    expect(result.stdout).toContain("| mean pass@1 | 75% | 63% | -13% |");
    expect(result.stdout).toContain("| median time | 2.5s | 3.3s | +0.8s |");
    expect(result.stdout).toContain("| Flags |");
    expect(result.stdout).toContain("cost +60%; time +150%; pass -25");
    expect(result.stdout).toContain("| - |");
  });

  it("prints the bootstrap significance section only when asked, on the committed baseline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tool-use-significance-"));
    tempRoots.push(root);
    const baselinePath = path.join(process.cwd(), "test/evals/baselines/core.json");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
      cases: Array<Record<string, unknown> & { id: string }>;
    };
    // A fresh summary has runResults; the baseline has none. The significance
    // read must ignore them and use only the per-case scores.
    const candidatePath = path.join(root, "candidate.json");
    await writeFile(candidatePath, `${JSON.stringify(baseline, null, 2)}\n`);
    const flipped = baseline.cases.map((entry) =>
      entry.id === "find.easy.dentist"
        ? { ...entry, passAtK: 1, passRate: 1, runResults: [{ run: 0, status: "passed" }] }
        : entry,
    );
    const flippedPath = path.join(root, "flipped.json");
    await writeFile(
      flippedPath,
      `${JSON.stringify({ ...baseline, cases: flipped }, null, 2)}\n`,
    );

    function runCompare(argv: string[]) {
      return spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/run-tool-use-evals.ts", ...argv],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    }

    const plain = runCompare(["--compare", baselinePath, candidatePath]);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout).toContain("# Tool-use eval comparison");
    expect(plain.stdout).not.toContain("## Significance");

    const plainFlipped = runCompare(["--compare", baselinePath, flippedPath]);
    expect(plainFlipped.status, plainFlipped.stderr).toBe(0);
    expect(plainFlipped.stdout).not.toContain("## Significance");

    const significance = runCompare(["--compare", "--significance", baselinePath, flippedPath]);
    expect(significance.status, significance.stderr).toBe(0);
    expect(significance.stdout.startsWith(plainFlipped.stdout)).toBe(true);
    expect(significance.stdout).toContain("## Significance");
    expect(significance.stdout).toMatch(/\| Metric \| Baseline \| Candidate \| Difference \| 95% CI \| Verdict \|/);
    expect(significance.stdout).toContain("2000 resamples");
    expect(significance.stdout).toContain("seed 12345");
    expect(significance.stdout).toContain("find.easy.dentist");

    const excluded = runCompare([
      "--compare",
      "--significance",
      "--exclude",
      "find.easy.dentist",
      baselinePath,
      flippedPath,
    ]);
    expect(excluded.status, excluded.stderr).toBe(0);
    expect(excluded.stdout).toContain("Excluded: find.easy.dentist");
    expect(excluded.stdout).toContain("24 paired cases");
  });

  it("rejects an unknown --exclude id and a lone --significance", () => {
    const baselinePath = path.join(process.cwd(), "test/evals/baselines/core.json");
    function runCompare(argv: string[]) {
      return spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/run-tool-use-evals.ts", ...argv],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    }

    const typo = runCompare([
      "--compare",
      "--significance",
      "--exclude",
      "tools.medium.wbe",
      baselinePath,
      baselinePath,
    ]);
    expect(typo.status, typo.stderr).toBe(1);
    expect(typo.stdout).toContain("# Tool-use eval comparison");
    expect(typo.stdout).toContain("## Significance");
    expect(typo.stderr).toContain("tools.medium.wbe");
    expect(typo.stderr).toMatch(/unknown --exclude/i);

    const lone = runCompare(["--significance", baselinePath, baselinePath]);
    expect(lone.status, lone.stderr).toBe(1);
    expect(lone.stderr).toContain("--significance needs --compare");
    expect(lone.stderr).not.toContain("Unexpected argument");
    expect(lone.stdout).toBe("");
  });

  describe("thinking level in the runner", () => {
    function runRunner(argv: string[], env: Record<string, string> = {}) {
      return spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/run-tool-use-evals.ts", ...argv],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            AGENTIC_CHAT_API_KEY: "",
            AGENTIC_CHAT_THINKING_LEVEL: "",
            ...env,
          },
        },
      );
    }

    async function writeSuite(mutate: (suite: Record<string, unknown>) => void): Promise<string> {
      const root = await mkdtemp(path.join(tmpdir(), "tool-use-thinking-"));
      tempRoots.push(root);
      const suite = cloneSuite();
      mutate(suite);
      const suitePath = path.join(root, "thinking.eval.json");
      await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
      return suitePath;
    }

    it("prints the effective level per case and its source", async () => {
      const suitePath = await writeSuite((suite) => {
        delete suite.thinkingLevel;
      });
      const result = runRunner(["--suite", suitePath, "--dry-run", "--case", "none.arithmetic"]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Thinking level: low (default)");
      expect(result.stdout).toContain("- none.arithmetic: 3 run(s), 0 seed file(s), thinking low");
    });

    it("takes the suite field over the default", async () => {
      const suitePath = await writeSuite((suite) => {
        suite.thinkingLevel = "medium";
      });
      const result = runRunner(["--suite", suitePath, "--dry-run", "--case", "none.arithmetic"]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Thinking level: medium (suite)");
    });

    it("takes the env var over the suite field and the CLI over the env var", async () => {
      const suitePath = await writeSuite((suite) => {
        suite.thinkingLevel = "minimal";
      });
      const fromEnv = runRunner(["--suite", suitePath, "--dry-run", "--case", "none.arithmetic"], {
        AGENTIC_CHAT_THINKING_LEVEL: "high",
      });
      expect(fromEnv.status, fromEnv.stderr).toBe(0);
      expect(fromEnv.stdout).toContain("Thinking level: high (env)");

      const fromCli = runRunner(
        ["--suite", suitePath, "--dry-run", "--case", "none.arithmetic", "--thinking-level", "off"],
        { AGENTIC_CHAT_THINKING_LEVEL: "high" },
      );
      expect(fromCli.status, fromCli.stderr).toBe(0);
      expect(fromCli.stdout).toContain("Thinking level: off (cli)");
    });

    it("rejects an unknown level from the CLI or the env var", async () => {
      const suitePath = await writeSuite(() => {});
      const fromCli = runRunner(["--suite", suitePath, "--dry-run", "--thinking-level", "none"]);
      expect(fromCli.status).toBe(1);
      expect(fromCli.stderr).toContain("--thinking-level must be one of off, minimal, low, medium, high, xhigh");

      const fromEnv = runRunner(["--suite", suitePath, "--dry-run"], {
        AGENTIC_CHAT_THINKING_LEVEL: "max",
      });
      expect(fromEnv.status).toBe(1);
      expect(fromEnv.stderr).toContain("AGENTIC_CHAT_THINKING_LEVEL must be one of");
    });

    it("lets a case pin override the run level in the plan", async () => {
      const suitePath = await writeSuite((suite) => {
        suite.thinkingLevel = "high";
        (suite.cases as Array<Record<string, unknown>>)[0].thinkingLevel = "off";
      });
      const result = runRunner(["--suite", suitePath, "--dry-run"]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Thinking level: high (suite)");
      expect(result.stdout).toMatch(/^- none\.arithmetic: 3 run\(s\), 0 seed file\(s\), thinking off$/m);
      expect(result.stdout).toMatch(/^- edit\.find-and-edit: 3 run\(s\), \d+ seed file\(s\), thinking high$/m);
    });
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
