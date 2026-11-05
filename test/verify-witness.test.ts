import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("verify-witness", () => {
  it(
    "rejects a test that passes without the fix and accepts a real witness",
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
    },
    120_000,
  );
});
