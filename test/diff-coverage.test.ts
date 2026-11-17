import { describe, expect, it } from "vitest";
import { diffCoverage, formatDiffCoverage, parseUnifiedDiff } from "../scripts/diff-coverage.mjs";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -3,0 +4,3 @@ export function a() {",
  "+  one();",
  "+  two();",
  "+  // comment",
  "@@ -20 +23 @@",
  "+  three();",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-x",
  "diff --git a/src/new.ts b/src/new.ts",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1 @@",
  "+export const n = 1;",
].join("\n");

const statement = (line: number) => ({ start: { line, column: 0 }, end: { line, column: 10 } });

describe("diff coverage", () => {
  it("reads new-side changed lines from a zero-context diff and skips deletions", () => {
    const changed = parseUnifiedDiff(DIFF);
    expect([...changed.keys()]).toEqual(["src/a.ts", "src/new.ts"]);
    expect([...changed.get("src/a.ts")!]).toEqual([4, 5, 6, 23]);
  });

  it("counts only executable changed lines and lists the ones no test ran", () => {
    const coverage = {
      "/repo/src/a.ts": {
        path: "/repo/src/a.ts",
        statementMap: { 0: statement(4), 1: statement(5), 2: statement(23) },
        s: { 0: 3, 1: 0, 2: 0 },
      },
    };
    const rows = diffCoverage(parseUnifiedDiff(DIFF), coverage, "/repo");
    expect(rows).toEqual([
      { file: "src/a.ts", executable: 3, covered: 1, uncovered: [5, 23], loaded: true },
      { file: "src/new.ts", executable: null, covered: 0, uncovered: [1], loaded: false },
    ]);
    expect(formatDiffCoverage(rows)).toBe(
      "diff coverage: 33.3% (1/3 changed lines)\n  src/a.ts: 1/3 uncovered 5, 23\n  src/new.ts: not loaded by any unit test\n",
    );
    expect(formatDiffCoverage(rows, { markdown: true })).toContain("| `src/a.ts` | 1/3 | 5, 23 |");
  });

  it("says so when the change has no executable src/ lines", () => {
    expect(formatDiffCoverage([])).toBe("diff coverage: no changed executable src/ lines\n");
  });
});
