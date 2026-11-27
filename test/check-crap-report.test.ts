import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appendStepSummary, formatCrapMarkdown } from "../scripts/report-crap.mjs";

const reportScript = fileURLToPath(new URL("../scripts/report-crap.mjs", import.meta.url));

const report = {
  summary: { files: 2, functions: 3, aboveMax: 1 },
  functions: [
    { file: "src/safe.ts", name: "safe", line: 5, complexity: 2, coverage: 100, crap: 2, level: "pass" },
    { file: "src/risky.ts", name: "risky", line: 10, complexity: 9, coverage: 0, crap: 90, level: "fail" },
    { file: "src/mid.ts", name: "mid|dle", line: 20, complexity: 5, coverage: 50, crap: 30.25, level: "warn" },
  ],
  missingFiles: ["src/risky.ts"],
};

describe("CRAP report", () => {
  it("sorts the worst functions first and states that the report is advisory", () => {
    const markdown = formatCrapMarkdown(report);
    expect(markdown).toContain("3 functions across 2 files; 1 above the CRAP 30 guideline");
    expect(markdown).toContain("Advisory: this report does not gate the build.");
    expect(markdown.indexOf("| 90.0 | 9 | 0.0% | `risky`")).toBeLessThan(
      markdown.indexOf("| 30.3 | 5 | 50.0% |"),
    );
    expect(markdown.indexOf("| 30.3 | 5 | 50.0% |")).toBeLessThan(
      markdown.indexOf("| 2.0 | 2 | 100.0% | `safe`"),
    );
  });

  it("escapes table cells, keeps the location, and lists missing coverage evidence", () => {
    const markdown = formatCrapMarkdown(report);
    expect(markdown).toContain("`mid\\|dle`");
    expect(markdown).toContain("`src/risky.ts:10`");
    expect(markdown).toContain("Missing coverage evidence (1): `src/risky.ts`");
    expect(markdown).toContain("Full JSON: `coverage/crap.json`");
  });

  it("honors the row limit and handles an empty report", () => {
    const limited = formatCrapMarkdown(report, { limit: 1 });
    expect(limited).toContain("`risky`");
    expect(limited).not.toContain("`safe`");

    const empty = formatCrapMarkdown({ functions: [], summary: { files: 0, functions: 0, aboveMax: 0 } });
    expect(empty).toContain("No function matched the configured minimum size.");
    expect(empty).not.toContain("Missing coverage evidence");
  });

  it("appends to the GitHub step summary only when the file is configured", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crap-summary-"));
    const file = path.join(dir, "summary.md");
    try {
      expect(appendStepSummary("## CRAP report\n", file)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("## CRAP report\n");
      expect(appendStepSummary("ignored", "")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a broken report in the advisory lane, but fails with --strict", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crap-missing-"));
    try {
      const advisory = spawnSync(process.execPath, [reportScript], { cwd: dir, encoding: "utf8" });
      expect(advisory.status).toBe(0);
      expect(advisory.stderr).toContain("report skipped (advisory)");

      const strict = spawnSync(process.execPath, [reportScript, "--strict"], { cwd: dir, encoding: "utf8" });
      expect(strict.status).toBe(1);
      expect(strict.stderr).toContain("missing coverage/coverage-final.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
