import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  countRuns,
  defectRows,
  formatDigest,
  foundBy,
  renderDefects,
  tallyFoundBy,
} from "../scripts/gate-report.mjs";

/** Runs with `count` copies of each conclusion, as `gh run list --json conclusion` returns them. */
function runs(spec: Record<string, number>): Array<{ conclusion: string }> {
  return Object.entries(spec).flatMap(([conclusion, count]) => Array.from({ length: count }, () => ({ conclusion })));
}

describe("gate digest (#393 T25)", () => {
  it("reproduces the audit's fixed window 2026-11-11..16: 13 CI, 29 witness, 172 review reds", () => {
    // The conclusions `gh run list` returned for that window on 2026-11-18.
    const gates = [
      { name: "ci", counts: countRuns(runs({ failure: 13, success: 269 })) },
      { name: "witness", counts: countRuns(runs({ "": 2, cancelled: 96, failure: 27, startup_failure: 2, success: 263 })) },
      { name: "review", counts: countRuns(runs({ cancelled: 85, failure: 172, skipped: 533, success: 210 })) },
    ];
    expect(gates.map((gate) => gate.counts.reds)).toEqual([13, 29, 172]);
    const text = formatDigest({
      since: "2026-11-11T06:27:00Z",
      until: "2026-11-16T16:33:59Z",
      gates,
      foundByTally: tallyFoundBy([]),
      flaky: [],
    });
    expect(text).toContain("  ci         13 red of 282");
    expect(text).toContain("  witness    29 red of 390 (cancelled 96, failure 27, none 2, startup_failure 2, success 263)");
    expect(text).toContain("  review    172 red of 1000");
  });

  it("triages a failed log by keyword; anything unmatched counts as real", () => {
    expect(classifyFailure("Error: no verdict at head abc1234")).toBe("process");
    expect(classifyFailure("element click intercepted: <div class=\"modal-bg\">")).toBe("flake");
    expect(classifyFailure("npm ERR! network ETIMEDOUT")).toBe("infra");
    expect(classifyFailure("ERR_PACKAGE_PATH_NOT_EXPORTED ./utils/estimate")).toBe("real");
  });

  it("reads the Found by: line, ignores unknown layers, and tallies catches per layer", () => {
    expect(foundBy("## Why\n\nFound by: chaos\n")).toBe("chaos");
    expect(foundBy("Found by: `review`")).toBe("review");
    expect(foundBy("Found by: luck")).toBeUndefined();
    expect(foundBy(undefined)).toBeUndefined();
    const { tally, unlabelled } = tallyFoundBy([{ body: "Found by: chaos" }, { body: "Found by: chaos" }, { body: "Found by: unit" }, { body: "no line" }]);
    expect(tally.chaos).toBe(2);
    expect(tally.unit).toBe(1);
    expect(unlabelled).toBe(1);
  });

  it("regenerates only the marked block of the escaped-defect page, newest fix first", () => {
    const rows = defectRows([
      { number: 7, title: "fix: a | b", body: "Found by: e2e", mergedAt: "2026-11-01T10:00:00Z" },
      { number: 9, title: "fix: later", body: "Found by: user", mergedAt: "2026-11-03T10:00:00Z" },
      { number: 8, title: "feat: no line", body: "", mergedAt: "2026-11-02T10:00:00Z" },
    ]);
    expect(rows).toEqual(["| 2026-11-03 | #9 | fix: later | user |", "| 2026-11-01 | #7 | fix: a \\| b | e2e |"]);
    const doc = "# Escaped defects\n\nintro\n<!-- generated: defects start -->\nold\n<!-- generated: defects end -->\n\nfooter\n";
    const out = renderDefects(doc, rows);
    expect(out).toContain("intro\n<!-- generated: defects start -->\n| Merged | PR | Fix | Found by |");
    expect(out).not.toContain("old");
    expect(out).toContain("footer");
    expect(() => renderDefects("# no markers", rows)).toThrow(/no generated block/);
  });
});
