import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateToolUseSuite, type ToolUseCase, type ToolUseSuite } from "../scripts/eval/tool-use-core";
import {
  emptyObservation,
  expandCaseSeed,
  fixturePlanFields,
  needsMcpFixture,
  parseRunRecord,
  planRuns,
  selectCases,
  shardPlan,
  type ToolUsePlan,
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
    expect(() => selectCases(loadSuite("regression"), { smoke: true })).toThrow(/defines no smoke slice/);
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

describe("tool-use MCP fixture", () => {
  function evalCase(overrides: Partial<ToolUseCase> = {}): ToolUseCase {
    return {
      id: "tools.medium.search",
      prompt: "Find the right MCP tool and use it.",
      seed: { files: {}, binaryFiles: {} },
      checks: [],
      ...overrides,
    };
  }

  it("needs the fake MCP server only when a case turns MCP on", () => {
    expect(needsMcpFixture([evalCase({ settings: { "mcp.enabled": true } })])).toBe(true);
    expect(needsMcpFixture([evalCase({ settings: { "mcp.enabled": false } })])).toBe(false);
    expect(needsMcpFixture([evalCase({ settings: { "web.enabled": true } })])).toBe(false);
    expect(needsMcpFixture([evalCase()])).toBe(false);
    expect(needsMcpFixture([])).toBe(false);
  });

  it("writes an MCP fixture URL into the plan only when a case needs that server", () => {
    const mcpCase = evalCase({ settings: { "mcp.enabled": true } });
    expect(fixturePlanFields([mcpCase], { mcp: "http://localhost:41234/mcp" })).toEqual({
      mcpFixtureUrl: "http://localhost:41234/mcp",
    });
    expect(fixturePlanFields([evalCase()], { mcp: "http://localhost:41234/mcp" })).toEqual({});
    expect(fixturePlanFields([], { web: "http://localhost:8080", mcp: "http://localhost:41234/mcp" })).toEqual({});
  });

  it("keeps the web and MCP fixture fields independent", () => {
    const webCase = evalCase({ prompt: "Fetch {{fixture}}/article.", settings: { "web.enabled": true } });
    const mcpCase = evalCase({ id: "tools.medium.mcp", settings: { "mcp.enabled": true } });

    expect(fixturePlanFields([webCase], { web: "http://localhost:8080", mcp: "http://localhost:41234/mcp" })).toEqual({
      fixtureBaseUrl: "http://localhost:8080",
    });
    expect(
      fixturePlanFields([webCase, mcpCase], { web: "http://localhost:8080", mcp: "http://localhost:41234/mcp" }),
    ).toEqual({ fixtureBaseUrl: "http://localhost:8080", mcpFixtureUrl: "http://localhost:41234/mcp" });
  });
});

describe("tool-use suite smoke validation", () => {
  it("rejects a smoke id that is not a suite case", () => {
    const suite = rawSuite("core");
    suite.smoke = ["find.easy.dentist", "no.such.case"];
    expect(() => validateToolUseSuite(suite)).toThrow(/suite\.smoke\[1\] is not a case id in this suite: no\.such\.case/);
  });

  it("rejects a repeated id, an empty list, and a non-array", () => {
    const suite = rawSuite("core");
    suite.smoke = ["find.easy.dentist", "find.easy.dentist"];
    expect(() => validateToolUseSuite(suite)).toThrow(/repeats the case id find\.easy\.dentist/);
    suite.smoke = [];
    expect(() => validateToolUseSuite(suite)).toThrow(/suite\.smoke must name at least one case/);
    suite.smoke = "find.easy.dentist";
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

    const handWritten = loadSuite("regression").cases.find((entry) => !entry.seed.vault);
    if (!handWritten) throw new Error("the regression suite has no hand-written case");
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

describe("parallel plan split (#392 item 7)", () => {
  function plan(caseCount: number, runsPerCase: number): ToolUsePlan {
    const cases = Array.from({ length: caseCount }, (_, index) => ({ id: `case.${index + 1}` }) as ToolUseCase);
    return { cases, runs: planRuns(cases, runsPerCase) } as ToolUsePlan;
  }

  it("splits 81 runs over 3 instances, 27 each, and never splits a case", () => {
    const whole = plan(27, 3);
    const shards = shardPlan(whole, 3);

    expect(shards.map((shard) => shard.runs.length)).toEqual([27, 27, 27]);
    expect(shards.map((shard) => shard.shard)).toEqual([1, 2, 3]);
    expect(shards.every((shard) => shard.parallel === 3)).toBe(true);
    const owner = new Map<string, number>();
    for (const shard of shards) {
      for (const run of shard.runs) {
        expect(owner.get(run.caseId) ?? shard.shard, `${run.caseId} is split`).toBe(shard.shard);
        owner.set(run.caseId, shard.shard ?? 0);
      }
      expect(shard.cases.map((entry) => entry.id).sort()).toEqual([...new Set(shard.runs.map((run) => run.caseId))].sort());
    }
    expect(shards.flatMap((shard) => shard.runs).length).toBe(81);
    expect(new Set(shards.flatMap((shard) => shard.runs).map((run) => `${run.caseId}#${run.run}`)).size).toBe(81);
  });

  it("keeps the plan order inside a shard, drops empty instances, and leaves --parallel 1 whole", () => {
    const whole = plan(2, 5);
    const shards = shardPlan(whole, 4);
    expect(shards).toHaveLength(2);
    expect(shards[0].runs.map((run) => run.run)).toEqual([1, 2, 3, 4, 5]);
    const single = shardPlan(whole, 1);
    expect(single).toHaveLength(1);
    expect(single[0].runs).toEqual(whole.runs);
    expect(() => shardPlan(whole, 0)).toThrow(/--parallel must be an integer/);
  });

  it("balances uneven cases by run count, largest first", () => {
    const cases = ["a", "b", "c", "d"].map((id) => ({ id }) as ToolUseCase);
    const runs = [...planRuns([cases[0]], 6), ...planRuns(cases.slice(1), 2)];
    const shards = shardPlan({ cases, runs } as ToolUsePlan, 2);
    expect(shards.map((shard) => shard.runs.length)).toEqual([6, 6]);
    expect(shards[0].cases.map((entry) => entry.id)).toEqual(["a"]);
  });
});
