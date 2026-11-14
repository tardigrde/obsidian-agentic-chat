import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Read stryker.config.mjs in a fresh process, so env changes take effect. */
function strykerConfig(env: Record<string, string> = {}): { thresholds: { break: number | null }; jsonReporter: { fileName: string } } {
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", 'const m = await import("./stryker.config.mjs"); console.log(JSON.stringify(m.default));'],
    { encoding: "utf8", env: { ...process.env, STRYKER_REPORT_ONLY: "", ...env } },
  );
  return JSON.parse(out) as ReturnType<typeof strykerConfig>;
}

describe("stryker config (#290 nightly)", () => {
  it("breaks below 70 by default", () => {
    const config = strykerConfig();
    expect(config.thresholds.break).toBe(70);
    expect(config.jsonReporter.fileName).toBe("reports/mutation/mutation.json");
  });

  it("never breaks in report-only mode and writes a separate report", () => {
    const config = strykerConfig({ STRYKER_REPORT_ONLY: "1" });
    expect(config.thresholds.break).toBeNull();
    expect(config.jsonReporter.fileName).toBe("reports/mutation/changed.json");
  });
});
