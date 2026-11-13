import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verdictFor } from "../scripts/verify-witness.mjs";

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

describe("verify-witness red classification", () => {
  const green = { status: 0, combined: "1 passing" };
  const red = (combined: string) => ({ status: 1, combined });

  it("rejects a red run that died because an imported name is missing", () => {
    // #326 review: reverting a test helper file left the import undefined.
    const tsx = red("TypeError: (0 , import_layout.waitForComposerReady) is not a function\n1 failing");
    const vitest = red("TypeError: __vi_import_0__.quickAskEmptyMessage is not a function\nTests  1 failed (1)");
    for (const run of [tsx, vitest]) {
      const result = verdictFor(run, green);
      expect(result.verdict).toBe("FAIL");
      expect(result.detail).toContain("missing import");
    }
  });

  it("still accepts a red run where the code under test throws a TypeError", () => {
    const result = verdictFor(red("TypeError: handler is not a function\n  at run (src/a.ts:3)\nTests  1 failed (1)"), green);
    expect(result.verdict).toBe("PASS");
  });
});
