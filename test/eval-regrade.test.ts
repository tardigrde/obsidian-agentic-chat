import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatRegrade, regradeRun } from "../scripts/eval/regrade";
import type { ToolUseCase } from "../scripts/eval/tool-use-core";

const OLD_CASE: ToolUseCase = {
  id: "edit.easy.typo",
  prompt: "Fix the typo.",
  seed: { files: { "Note.md": "teh cat\n" }, binaryFiles: {} },
  // The old check was wrong: it wanted the typo to stay.
  checks: [{ type: "file_contains", path: "Note.md", text: "teh cat" }],
};

const FIXED_CHECKS: ToolUseCase["checks"] = [
  { type: "file_contains", path: "Note.md", text: "the cat" },
  { type: "file_not_contains", path: "Note.md", text: "teh" },
];

function record(run: number, note: string, extra: Record<string, unknown> = {}) {
  return {
    caseId: OLD_CASE.id,
    run,
    ms: 1000,
    usage: { input: 10, output: 5, totalTokens: 15 },
    modelCalls: 1,
    observed: { files: { "Note.md": note }, frontmatter: {}, links: {}, unresolvedLinks: {}, toolCalls: [{ name: "edit" }], answer: "Done." },
    ...extra,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "eval-regrade-"));
  writeFileSync(
    path.join(dir, "plan.json"),
    JSON.stringify({
      suite: { name: "core", path: "test/evals/tool-use/core.eval.json" },
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cases: [OLD_CASE, { ...OLD_CASE, id: "gone.easy.case" }],
      runs: [
        { caseId: OLD_CASE.id, run: 1 },
        { caseId: OLD_CASE.id, run: 2 },
        { caseId: OLD_CASE.id, run: 3 },
        { caseId: "gone.easy.case", run: 1 },
      ],
    }),
  );
  writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({ cases: [{ id: OLD_CASE.id, runResults: [{ run: 1, status: "fail" }, { run: 2, status: "pass" }, { run: 3, status: "error" }] }] }),
  );
  const caseDir = path.join(dir, "results", OLD_CASE.id);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(path.join(caseDir, "1.json"), JSON.stringify(record(1, "the cat\n")));
  writeFileSync(path.join(caseDir, "2.json"), JSON.stringify(record(2, "teh cat\n")));
  writeFileSync(path.join(caseDir, "3.json"), JSON.stringify(record(3, "the cat\n", { error: "harness died" })));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("eval regrade", () => {
  it("grades saved records with the current checks and keeps a harness error an error", () => {
    const result = regradeRun(dir, [{ ...OLD_CASE, checks: FIXED_CHECKS }]);

    expect(result.rows).toEqual([
      { caseId: OLD_CASE.id, run: 1, before: "fail", after: "pass" },
      { caseId: OLD_CASE.id, run: 2, before: "pass", after: "fail" },
      { caseId: OLD_CASE.id, run: 3, before: "error", after: "error" },
    ]);
    expect(result.missingCases).toEqual(["gone.easy.case"]);
  });

  it("with unchanged checks reproduces the old statuses and reports no change", () => {
    const result = regradeRun(dir, [OLD_CASE]);
    expect(result.rows.map((row) => row.after)).toEqual(["fail", "pass", "error"]);
    expect(formatRegrade(result)).toContain("Regraded 3 run(s) with the current checks; 0 changed.");
  });

  it("marks a changed status and names a case it could not grade", () => {
    const text = formatRegrade(regradeRun(dir, [{ ...OLD_CASE, checks: FIXED_CHECKS }]));
    expect(text).toContain("2 changed");
    expect(text).toContain("| edit.easy.typo | 1 | fail | **pass** |");
    expect(text).toContain("Not in the suite any more (not graded): gone.easy.case");
  });
});
