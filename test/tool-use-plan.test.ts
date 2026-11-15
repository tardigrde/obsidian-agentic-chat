import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateToolUseSuite, type ToolUseSuite } from "../scripts/eval/tool-use-core";
import {
  emptyObservation,
  expandCaseSeed,
  parseRunRecord,
  planRuns,
  selectCases,
} from "../scripts/eval/tool-use-plan";

const CATEGORIES = ["find", "edit", "organize", "create", "properties", "tools", "safety", "recovery"];

function loadSuite(name: string): ToolUseSuite {
  const file = path.join(process.cwd(), "test/evals/tool-use", `${name}.eval.json`);
  return validateToolUseSuite(JSON.parse(readFileSync(file, "utf8")) as unknown);
}

function rawSuite(name: string): Record<string, unknown> {
  const file = path.join(process.cwd(), "test/evals/tool-use", `${name}.eval.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("tool-use case selection", () => {
  it("runs every suite case by default", () => {
    const suite = loadSuite("core");
    expect(selectCases(suite)).toEqual(suite.cases);
  });

  it("selects explicit ids in the requested order and drops repeats", () => {
    const suite = loadSuite("core");
    const selected = selectCases(suite, { caseIds: ["edit.easy.typo", "find.easy.dentist", "edit.easy.typo"] });
    expect(selected.map((entry) => entry.id)).toEqual(["edit.easy.typo", "find.easy.dentist"]);
  });

  it("names an unknown case id", () => {
    expect(() => selectCases(loadSuite("core"), { caseIds: ["no.such.case"] })).toThrow(/no\.such\.case/);
  });

  it("takes the smoke slice from the suite: one core case per category", () => {
    const suite = loadSuite("core");
    const ids = selectCases(suite, { smoke: true }).map((entry) => entry.id);
    expect(ids).toEqual(suite.smoke);
    expect(ids.map((id) => id.split(".")[0])).toEqual(CATEGORIES);
  });

  it("refuses --smoke for a suite with no smoke slice, and with --case", () => {
    expect(() => selectCases(loadSuite("tool-use"), { smoke: true })).toThrow(/defines no smoke slice/);
    expect(() => selectCases(loadSuite("core"), { smoke: true, caseIds: ["edit.easy.typo"] })).toThrow(
      /--smoke cannot be combined with --case/,
    );
  });

  it("plans runsPerCase numbered runs per case, case by case", () => {
    const cases = selectCases(loadSuite("core"), { caseIds: ["edit.easy.typo", "find.easy.dentist"] });
    expect(planRuns(cases, 2)).toEqual([
      { caseId: "edit.easy.typo", run: 1 },
      { caseId: "edit.easy.typo", run: 2 },
      { caseId: "find.easy.dentist", run: 1 },
      { caseId: "find.easy.dentist", run: 2 },
    ]);
  });
});

describe("tool-use suite smoke validation", () => {
  it("rejects a smoke id that is not a suite case", () => {
    const suite = rawSuite("core");
    suite.smoke = ["find.hard.venue", "no.such.case"];
    expect(() => validateToolUseSuite(suite)).toThrow(/suite\.smoke\[1\] is not a case id in this suite: no\.such\.case/);
  });

  it("rejects a repeated id, an empty list, and a non-array", () => {
    const suite = rawSuite("core");
    suite.smoke = ["find.hard.venue", "find.hard.venue"];
    expect(() => validateToolUseSuite(suite)).toThrow(/repeats the case id find\.hard\.venue/);
    suite.smoke = [];
    expect(() => validateToolUseSuite(suite)).toThrow(/suite\.smoke must name at least one case/);
    suite.smoke = "find.hard.venue";
    expect(() => validateToolUseSuite(suite)).toThrow(/suite\.smoke must be an array/);
  });
});

describe("tool-use seed expansion", () => {
  it("merges case files over the generated vault and leaves a hand-written seed alone", () => {
    const suite = loadSuite("core");
    const generated = suite.cases.find((entry) => entry.seed.vault);
    if (!generated) throw new Error("the core suite has no generated-vault case");
    const expanded = expandCaseSeed(generated);
    expect(expanded.seed.vault).toBeUndefined();
    expect(Object.keys(expanded.seed.files).length).toBeGreaterThan(Object.keys(generated.seed.files).length);
    for (const [file, content] of Object.entries(generated.seed.files)) {
      expect(expanded.seed.files[file]).toBe(content);
    }

    const handWritten = loadSuite("tool-use").cases[0];
    expect(expandCaseSeed(handWritten)).toBe(handWritten);
  });
});

describe("tool-use run records", () => {
  const record = {
    caseId: "case.one",
    run: 2,
    ms: 1_200,
    usage: { input: 10, output: 5, totalTokens: 15 },
    modelCalls: 3,
    observed: {
      files: { "a.md": "A", "bad.md": 7 },
      paths: ["a.md", "invoice.pdf", 9],
      frontmatter: { "a.md": { status: "done" }, "bad.md": "nope" },
      links: { "a.md": ["b.md", 4] },
      unresolvedLinks: {},
      toolCalls: [{ name: "read" }, { name: "edit", isError: true }, "junk"],
      answer: "done",
    },
  };

  it("reads a record and drops values of the wrong type", () => {
    expect(parseRunRecord(record, "r.json")).toEqual({
      caseId: "case.one",
      run: 2,
      ms: 1_200,
      usage: { input: 10, output: 5, cacheRead: undefined, cacheWrite: undefined, totalTokens: 15 },
      modelCalls: 3,
      observed: {
        files: { "a.md": "A" },
        paths: ["a.md", "invoice.pdf"],
        frontmatter: { "a.md": { status: "done" } },
        links: { "a.md": ["b.md"] },
        unresolvedLinks: {},
        toolCalls: [
          { name: "read", isError: false },
          { name: "edit", isError: true },
        ],
        answer: "done",
      },
    });
  });

  it("keeps the harness error and the budget skip", () => {
    expect(parseRunRecord({ ...record, error: "turn did not finish" }, "r.json").error).toBe("turn did not finish");
    const skipped = parseRunRecord({ ...record, observed: emptyObservation(), skippedBudget: "maxUsd" }, "r.json");
    expect(skipped.skippedBudget).toBe("maxUsd");
  });

  it("rejects a record that does not name its run or has no observation", () => {
    expect(() => parseRunRecord([], "r.json")).toThrow(/not an object: r\.json/);
    expect(() => parseRunRecord({ ...record, caseId: "" }, "r.json")).toThrow(/missing caseId or run/);
    expect(() => parseRunRecord({ ...record, observed: undefined }, "r.json")).toThrow(/no observation/);
  });
});
