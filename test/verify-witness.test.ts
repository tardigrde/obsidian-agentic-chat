import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("verify-witness", () => {
  it(
    "rejects non-witnesses and accepts a real witness",
    () => {
      const result = spawnSync(
        process.execPath,
        [path.resolve("scripts/verify-witness.mjs"), "--self-test"],
        { encoding: "utf8", timeout: 120_000 },
      );
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      expect(result.status, output).toBe(0);
      expect(output).toContain("SELF-TEST PASS");
      expect(output).toContain("negative: rejected a test that passes without the fix");
      expect(output).toContain("syntax error: rejected a red run that never reached an assertion");
      expect(output).toContain("no count: rejected a red run without a failed test count");
    },
    120_000,
  );
});
