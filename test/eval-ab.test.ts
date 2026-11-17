import { describe, expect, it } from "vitest";
import { abPlan, formatAbPlan, formatAbTable, parseAbArgs } from "../scripts/eval/ab";

describe("eval:ab arguments (#392 item 1)", () => {
  it("reads cases from repeated and comma lists, with the defaults", () => {
    const args = parseAbArgs(["--case", "a,b", "--case", "c", "--case", "a"], {});
    expect(args).toMatchObject({ cases: ["a", "b", "c"], runs: 5, base: "origin/main", suite: "test/evals/tool-use/core.eval.json", dryRun: false, nested: false });
  });

  it("runs nested under a desktop DISPLAY unless --no-nested", () => {
    expect(parseAbArgs(["--case", "a"], { DISPLAY: ":0" }).nested).toBe(true);
    expect(parseAbArgs(["--case", "a", "--no-nested"], { DISPLAY: ":0" }).nested).toBe(false);
  });

  it("refuses a missing case list, a bad run count, and a bad cap", () => {
    expect(() => parseAbArgs([], {})).toThrow("--case");
    expect(() => parseAbArgs(["--case", "a", "--runs", "0"], {})).toThrow("--runs");
    expect(() => parseAbArgs(["--case", "a", "--max-usd", "-1"], {})).toThrow("--max-usd");
    expect(parseAbArgs(["--help"], {}).help).toBe(true);
  });
});

describe("eval:ab plan", () => {
  const args = parseAbArgs(["--case", "x,y", "--runs", "3", "--base", "abc123", "--max-usd", "0.2"], { DISPLAY: ":0" });
  const plan = abPlan(args, { headRoot: "/repo", stamp: "S", tmpDir: "/tmp" });

  it("runs the base in a temporary worktree and the head in the current tree, both under logs/eval-runs/ab-<stamp>", () => {
    expect(plan.baseWorktree).toBe("/tmp/agentic-chat-ab-S");
    expect(plan.sides.map((side) => [side.label, side.cwd, side.outDir])).toEqual([
      ["base", "/tmp/agentic-chat-ab-S", "/repo/logs/eval-runs/ab-S/base"],
      ["head", "/repo", "/repo/logs/eval-runs/ab-S/head"],
    ]);
    const [base] = plan.sides;
    expect(base.command.slice(0, 2)).toEqual(["node", "/repo/scripts/run-nested.mjs"]);
    expect(base.command.join(" ")).toContain("--case x,y --runs 3 --run-id ab-S-base --out-dir /repo/logs/eval-runs/ab-S/base --max-usd 0.2");
  });

  it("prints both worktree paths in the dry-run plan", () => {
    const text = formatAbPlan(plan);
    expect(text).toContain("base: abc123 in /tmp/agentic-chat-ab-S");
    expect(text).toContain("head: current tree /repo");
  });
});

describe("eval:ab table", () => {
  const row = (id: string, passed: number, extra: Record<string, number> = {}) => ({
    id,
    passed,
    executed: 5,
    passAllK: passed === 5 ? 1 : 0,
    passRate: passed / 5,
    meanToolCalls: 3,
    meanUsd: 0.001,
    medianMs: 4_000,
    ...extra,
  });

  it("prints pass k/n per side, tool calls, cost, and time", () => {
    const text = formatAbTable(
      { costSource: "billed", cases: [row("organize.easy.invoice", 4)] },
      { costSource: "billed", cases: [row("organize.easy.invoice", 0, { meanToolCalls: 6, meanUsd: 0.002, medianMs: 6_500 })] },
    );
    expect(text).toContain("| organize.easy.invoice | 4/5 | 0/5 | 3.0 -> 6.0 | $0.00100 -> $0.00200 | 4.0 -> 6.5 |");
    expect(text).not.toContain("bootstrap");
  });

  it("adds the paired bootstrap for two or more cases", () => {
    const text = formatAbTable(
      { costSource: "billed", cases: [row("a", 5), row("b", 5)] },
      { costSource: "billed", cases: [row("a", 5), row("b", 2)] },
    );
    expect(text).toContain("| b | 5/5 | 2/5 |");
    expect(text).toContain("| total cost |");
    expect(text).toContain("| median case time |");
  });

  it("shows a missing side as a dash", () => {
    expect(formatAbTable({ cases: [] }, { cases: [row("new", 5)] })).toContain("| new | - | 5/5 |");
  });
});
