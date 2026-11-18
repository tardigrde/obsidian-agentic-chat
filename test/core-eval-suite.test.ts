import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  gradeRun,
  validateToolUseSuite,
  type ToolUseCase,
  type ToolUseCheck,
  type ToolUseCheckResult,
  type ToolUseSuite,
} from "../scripts/eval/tool-use-core";
import { generateVault } from "../scripts/eval/vault-generator";

const SUITES_DIR = path.join(process.cwd(), "test/evals/tool-use");
const SUITE_PATH = path.join(SUITES_DIR, "core.eval.json");
const CATEGORIES = [
  "find",
  "edit",
  "organize",
  "create",
  "properties",
  "tools",
  "safety",
  "recovery",
] as const;
const LEVELS = ["easy", "medium", "hard"] as const;
const CASE_IDS = [
  "find.easy.dentist",
  "find.easy.today",
  "edit.easy.typo",
  "organize.easy.invoice",
  "organize.medium.inbox",
  "organize.hard.atlas",
  "create.hard.weekly",
  "properties.hard.owners",
  "tools.easy.search",
  "tools.medium.mcp",
  "safety.medium.injection",
  "recovery.medium.stale",
];
/**
 * Restraint cases: doing nothing is the right answer, so a do-nothing run
 * passes them. Every other case in every live suite must fail it.
 */
const RESTRAINT_CASES = new Set(["safety.easy.private"]);

/** Check types that need the vault state, so empty observed files fail them. */
const FILE_CHECK_TYPES = new Set<ToolUseCheck["type"]>([
  "file_exists",
  "file_contains",
  "frontmatter_equals",
  "unchanged",
  "link_resolves",
  "no_unresolved_links",
]);

function loadSuite(file = SUITE_PATH): ToolUseSuite {
  return validateToolUseSuite(JSON.parse(readFileSync(file, "utf8")) as unknown);
}

/** Every live suite in test/evals/tool-use: the guards hold for all of them. */
function liveSuites(): ToolUseSuite[] {
  return readdirSync(SUITES_DIR)
    .filter((name) => name.endsWith(".eval.json"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => loadSuite(path.join(SUITES_DIR, name)));
}

function allCases(): ToolUseCase[] {
  return liveSuites().flatMap((suite) => suite.cases);
}

/** Mirror the runner: case files win over the generated base. */
function expandCase(evalCase: ToolUseCase): ToolUseCase {
  const vaultSeed = evalCase.seed.vault;
  if (!vaultSeed) return evalCase;
  const generated = generateVault(vaultSeed.size, vaultSeed.seed);
  return {
    ...evalCase,
    seed: {
      files: { ...generated.files, ...evalCase.seed.files },
      binaryFiles: evalCase.seed.binaryFiles,
    },
  };
}

function walkChecks(checks: ToolUseCheck[]): ToolUseCheck[] {
  return checks.flatMap((check) => (check.type === "any_of" ? [check, ...walkChecks(check.checks)] : [check]));
}

function literalAnswers(checks: ToolUseCheck[], type: "answer_contains" | "answer_not_contains"): string[] {
  return walkChecks(checks)
    .filter((check): check is Extract<ToolUseCheck, { type: typeof type }> => check.type === type && !check.regex)
    .map((check) => check.text);
}

function gradeEmpty(evalCase: ToolUseCase, answer = ""): ToolUseCheckResult[] {
  return gradeRun(evalCase, {
    files: {},
    frontmatter: {},
    links: {},
    unresolvedLinks: {},
    toolCalls: [],
    answer,
  }).checks;
}

/** A run that changed nothing and called no tool. */
function emptyObservation(answer: string) {
  return { files: {}, frontmatter: {}, links: {}, unresolvedLinks: {}, toolCalls: [], answer };
}

function hasFileCheck(checks: ToolUseCheck[]): boolean {
  return walkChecks(checks).some((check) => FILE_CHECK_TYPES.has(check.type));
}

function caseById(id: string): ToolUseCase {
  const found = allCases().find((entry) => entry.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return expandCase(found);
}

function gradeFiles(
  evalCase: ToolUseCase,
  files: Record<string, string>,
  links: Record<string, string[]> = {},
  toolCalls: Array<{ name: string }> = [],
): boolean {
  return gradeRun(evalCase, {
    files,
    frontmatter: {},
    links,
    unresolvedLinks: {},
    toolCalls,
    answer: "",
  }).ok;
}

describe("core eval suite", () => {
  it("accepts the committed core suite", () => {
    const suite = loadSuite();

    expect(suite.name).toBe("core");
    expect(suite.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(suite.runsPerCase).toBe(3);
    expect(suite.cases.map((entry) => entry.id)).toEqual(CASE_IDS);
  });

  it("has eight categories, ~12 cases, and unique ids", () => {
    const suite = loadSuite();
    const byCategory = new Map<string, number>();
    const byLevel = new Map<string, number>();
    const seen = new Set<string>();

    for (const evalCase of suite.cases) {
      expect(seen.has(evalCase.id), `duplicate id ${evalCase.id}`).toBe(false);
      seen.add(evalCase.id);

      const parts = evalCase.id.split(".");
      expect(parts, `${evalCase.id} must be <category>.<level>.<slug>`).toHaveLength(3);
      const [category, level, ...slug] = parts;
      expect(CATEGORIES).toContain(category);
      expect(LEVELS).toContain(level);
      expect(slug.join(".").length).toBeGreaterThan(0);
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      byLevel.set(level, (byLevel.get(level) ?? 0) + 1);
    }

    expect([...byCategory.keys()].sort()).toEqual([...CATEGORIES].sort());
    const perCategory: Record<string, number> = { find: 2, edit: 1, organize: 3, create: 1, properties: 1, tools: 2, safety: 1, recovery: 1 };
    for (const category of CATEGORIES) expect(byCategory.get(category), category).toBe(perCategory[category]);
    expect(byLevel.get("easy"), "easy").toBe(5);
    expect(byLevel.get("medium"), "medium").toBe(4);
    expect(byLevel.get("hard"), "hard").toBe(3);
  });

  it("uses an S vault for easy and medium cases and an M vault for every hard case", () => {
    for (const evalCase of loadSuite().cases) {
      const level = evalCase.id.split(".")[1];
      expect(evalCase.seed.vault, `${evalCase.id} needs seed.vault`).toBeDefined();
      expect(evalCase.seed.vault?.size, evalCase.id).toBe(level === "hard" ? "M" : "S");
      expect(Number.isInteger(evalCase.seed.vault?.seed), evalCase.id).toBe(true);
      expect(Object.keys(evalCase.seed.files).length, `${evalCase.id} needs its own needles`).toBeGreaterThan(0);
    }
  });

  it("gives every core case a tool-call budget and at least one check", () => {
    for (const evalCase of loadSuite().cases) {
      expect(evalCase.checks.length, evalCase.id).toBeGreaterThan(0);
      expect(Number.isInteger(evalCase.expected?.maxToolCalls), evalCase.id).toBe(true);
      expect(evalCase.expected?.maxToolCalls ?? 0, evalCase.id).toBeGreaterThan(0);
    }
  });

  it("checks every expected maxToolCalls with a matching max_tool_calls check", () => {
    for (const evalCase of allCases()) {
      const max = evalCase.expected?.maxToolCalls;
      if (max === undefined) continue;
      const budgets = walkChecks(evalCase.checks).filter(
        (check): check is Extract<ToolUseCheck, { type: "max_tool_calls" }> => check.type === "max_tool_calls",
      );
      expect(budgets.length, `${evalCase.id} needs a max_tool_calls check`).toBeGreaterThan(0);
      expect(
        budgets.some((check) => check.max === max),
        `${evalCase.id} has no max_tool_calls check with max ${max}`,
      ).toBe(true);
    }
  });

  it("pairs web.enabled with a {{fixture}} prompt", () => {
    for (const evalCase of allCases()) {
      const usesFixture = evalCase.prompt.includes("{{fixture}}");
      const webEnabled = evalCase.settings?.["web.enabled"] === true;
      expect(webEnabled, `${evalCase.id} must set web.enabled when it uses {{fixture}}`).toBe(usesFixture);
    }
  });

  it("pairs every literal answer_contains with a literal answer_not_contains", () => {
    for (const evalCase of allCases()) {
      const positives = literalAnswers(evalCase.checks, "answer_contains");
      const negatives = literalAnswers(evalCase.checks, "answer_not_contains");
      for (const positive of positives) {
        expect(negatives.length, `${evalCase.id} has no negative partner for ${JSON.stringify(positive)}`).toBeGreaterThan(0);
        expect(negatives, `${evalCase.id} repeats ${JSON.stringify(positive)} as a negative`).not.toContain(positive);
      }
    }
  });

  it("fails every non-restraint case in every live suite for a do-nothing agent", () => {
    const passed: string[] = [];
    for (const evalCase of allCases()) {
      if (gradeRun(expandCase(evalCase), emptyObservation("")).ok) passed.push(evalCase.id);
    }
    // Exact: a case that a do-nothing run passes is either a named restraint
    // case or a case whose checks do not test anything.
    expect(passed.sort((a, b) => a.localeCompare(b))).toEqual([...RESTRAINT_CASES].sort((a, b) => a.localeCompare(b)));
  });

  it("fails every case in every live suite for an agent that dumps the whole vault into its answer", () => {
    for (const evalCase of allCases()) {
      const expanded = expandCase(evalCase);
      const dump = Object.entries(expanded.seed.files)
        .map(([file, content]) => `## ${file}\n${content}`)
        .join("\n\n");
      const observed = { ...emptyObservation(dump), files: expanded.seed.files };
      expect(gradeRun(expanded, observed).ok, `${evalCase.id} passed the dump-everything answer`).toBe(false);
    }
  });

  it("fails the chatterbox answer, including every literal positive and negative", () => {
    for (const evalCase of allCases()) {
      const chatter = [
        ...literalAnswers(evalCase.checks, "answer_contains"),
        ...literalAnswers(evalCase.checks, "answer_not_contains"),
      ].join(" ");
      const checks = gradeEmpty(expandCase(evalCase), chatter);
      const ok = checks.every((check) => check.ok);
      expect(ok, `${evalCase.id} passed the chatterbox answer`).toBe(false);
      if (!hasFileCheck(evalCase.checks)) {
        // An answer-only case has no file state to fail it; the negative
        // literal must be what fails the chatterbox.
        expect(checks.length, evalCase.id).toBeGreaterThan(0);
      }
    }
  });

  it("accepts either adjacent line order for edit.medium.heading and rejects other sections", () => {
    const evalCase = caseById("edit.medium.heading");
    const runbook = "400 Projects/Runbook.md";
    const seed = evalCase.seed.files[runbook];
    const insertAfter = (anchor: string) => seed.replace(anchor, `${anchor}\n- check the backup log`);

    const after = insertAfter("## Notes\n\n- beta one");
    const before = seed.replace("## Notes\n\n- beta one", "## Notes\n\n- check the backup log\n- beta one");
    const first = insertAfter("## Notes\n\n- alpha one");
    const third = insertAfter("## Notes\n\n- gamma one");
    for (const variant of [after, before, first, third]) {
      expect(variant, "the variant must change the seed").not.toBe(seed);
    }

    expect(gradeFiles(evalCase, { ...evalCase.seed.files, [runbook]: after }, {}, [{ name: "edit" }])).toBe(true);
    expect(gradeFiles(evalCase, { ...evalCase.seed.files, [runbook]: before }, {}, [{ name: "edit" }])).toBe(true);
    expect(gradeFiles(evalCase, { ...evalCase.seed.files, [runbook]: first }, {}, [{ name: "edit" }])).toBe(false);
    expect(gradeFiles(evalCase, { ...evalCase.seed.files, [runbook]: third }, {}, [{ name: "edit" }])).toBe(false);
  });

  it("states the Archive scope in properties.medium.normalize", () => {
    expect(caseById("properties.medium.normalize").prompt).toMatch(/including the Archive subfolder/i);
  });

  it("accepts external in any case for create.medium.summary and still rejects wrong figures", () => {
    const evalCase = caseById("create.medium.summary");
    const summaryPath = "400 Projects/Summit/Summit summary.md";
    const summary = (catering: string) =>
      [
        "# Summit summary",
        "",
        "- Venue: Riverside Loft",
        "- Budget: 14,800 EUR",
        `- Catering: ${catering}`,
        "",
        "Sources: [[2024-04-02 meeting]] and [[2024-04-16 meeting]].",
        "",
      ].join("\n");
    const files = (content: string) => ({ ...evalCase.seed.files, [summaryPath]: content });
    const links = {
      [summaryPath]: ["400 Projects/Summit/2024-04-02 meeting.md", "400 Projects/Summit/2024-04-16 meeting.md"],
    };
    const grade = (content: string) => gradeFiles(evalCase, files(content), links, [{ name: "write" }]);

    expect(grade(summary("External"))).toBe(true);
    expect(grade(summary("external"))).toBe(true);
    expect(grade(summary("external").replace("14,800 EUR", "14,500 EUR"))).toBe(false);
  });

  it("excludes the code-sample note from tools.easy.search without a heading ambiguity", () => {
    const evalCase = caseById("tools.easy.search");
    const codeSample = "200 Resources/Research/code-sample.md";

    expect(JSON.stringify(evalCase), "the old zephyr-code note must be gone").not.toContain("zephyr-code");
    expect(evalCase.seed.files[codeSample] ?? "", "the code-sample note is seeded").toContain("```text\nZephyr\n```");
    expect(literalAnswers(evalCase.checks, "answer_not_contains")).toContain("code-sample");

    const answer = ["- zephyr-alpha", "- zephyr-beta", "- zephyr-gamma", "- zephyr-meta"].join("\n");
    const grade = (text: string) =>
      gradeRun(evalCase, {
        files: evalCase.seed.files,
        frontmatter: {},
        links: {},
        unresolvedLinks: {},
        toolCalls: [{ name: "vault_inspect" }],
        answer: text,
      }).ok;

    expect(grade(answer), "the four real mentions must pass").toBe(true);
    expect(grade(`${answer}\n- code-sample`), "the code sample must fail").toBe(false);
  });

  it("uses the fixture redirect for tools.medium.web", () => {
    const evalCase = caseById("tools.medium.web");

    expect(evalCase.prompt).toContain("{{fixture}}/redirect");
    expect(evalCase.prompt).not.toContain("{{fixture}}/article");
    expect(evalCase.settings?.["web.enabled"]).toBe(true);
  });

  it("seeds a real NFD path whose NFC form differs", () => {
    const evalCase = allCases().find((entry) => entry.id === "recovery.easy.nfd");
    if (!evalCase) throw new Error("missing recovery.easy.nfd");

    const nfdPath = Object.keys(evalCase.seed.files).find((filePath) => filePath.normalize("NFC") !== filePath);
    expect(nfdPath, "recovery.easy.nfd needs a seed path with a combining mark").toBeDefined();
    const nfd = nfdPath as string;
    const nfc = nfd.normalize("NFC");

    expect(nfc).not.toBe(nfd);
    expect(/\p{M}/u.test(nfd), "the NFD path must contain a combining mark").toBe(true);
    expect(evalCase.prompt).toContain(path.posix.basename(nfc));
    expect(evalCase.seed.files[nfd]).toContain("CAFE-NFD-42");
  });
});
