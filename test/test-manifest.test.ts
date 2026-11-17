import { describe, expect, it } from "vitest";
import { checkSkips, findSkips } from "../scripts/check-skips.mjs";
import { checkManifest, groupFor, listTestFiles, loadManifest, type TestManifest } from "../scripts/check-test-manifest.mjs";
import { globToRegExp } from "../scripts/lib/glob.mjs";

// Built from parts so this file does not itself contain a skip call.
const SKIP = (title: string) => `it${"."}skip(${JSON.stringify(title)}, () => {});`;

function manifestOf(groups: Array<Partial<TestManifest["groups"][number]> & { id: string; globs: string[] }>): TestManifest {
  return {
    version: 1,
    testFilePatterns: ["test/**/*.test.ts"],
    groups: groups.map((group) => ({
      tier: "T1",
      runner: "vitest",
      triggers: [],
      needs: { display: false, key: false, network: false },
      budgetSeconds: 1,
      command: "npm run verify -- change <file>",
      why: "test",
      ...group,
    })),
  };
}

describe("test manifest", () => {
  it("names an unlisted file and a file in two groups", () => {
    const manifest = manifestOf([
      { id: "a", globs: ["test/a-*.test.ts"] },
      { id: "b", globs: ["test/{a-one,b}.test.ts"] },
    ]);
    const { errors } = checkManifest(manifest, ["test/a-one.test.ts", "test/b.test.ts", "test/fixture-unlisted.test.ts"]);
    expect(errors).toContain("test/fixture-unlisted.test.ts is in no group; add it to a group's globs in test/manifest.json");
    expect(errors.some((error) => error.startsWith("test/a-one.test.ts is in 2 groups"))).toBe(true);
  });

  it("honors a group's exclude list", () => {
    const manifest = manifestOf([
      { id: "smoke", globs: ["test/e2e/specs/smoke.e2e.ts"], tier: "T2" },
      { id: "specs", globs: ["test/e2e/specs/*.e2e.ts"], exclude: ["test/e2e/specs/smoke.e2e.ts"], tier: "T2" },
    ]);
    expect(groupFor(manifest, "test/e2e/specs/smoke.e2e.ts")?.id).toBe("smoke");
    expect(groupFor(manifest, "test/e2e/specs/settings-ui.e2e.ts")?.id).toBe("specs");
  });

  it("the repo manifest covers every test file exactly once", () => {
    const manifest = loadManifest();
    const files = listTestFiles(manifest);
    expect(files.length).toBeGreaterThan(250);
    expect(checkManifest(manifest, files).errors).toEqual([]);
  });

  it("glob braces and double stars behave", () => {
    expect(globToRegExp("test/**/*.test.ts").test("test/a.test.ts")).toBe(true);
    expect(globToRegExp("test/*.test.ts").test("test/live/a.test.ts")).toBe(false);
    expect(globToRegExp("src/settings*.ts").test("src/settings-store.ts")).toBe(true);
  });
});

describe("skip rule", () => {
  const manifest = manifestOf([
    { id: "unit", globs: ["test/unit/*.test.ts"], tier: "T1" },
    { id: "live", globs: ["test/live/*.test.ts"], tier: "T3" },
  ]);
  const run = (sources: Record<string, string>) =>
    checkSkips({ manifest, files: Object.keys(sources), read: (file) => sources[file] });

  it("fails a plain skip in a deterministic tier and names the line", () => {
    const { errors } = run({ "test/unit/a.test.ts": `\n${SKIP("todo")}\n` });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("test/unit/a.test.ts:2 skip in a T1 test");
  });

  it("accepts a flaky skip with an issue number and reports it", () => {
    const { errors, flaky } = run({ "test/unit/a.test.ts": SKIP("flaky #412: approval hook races the layout") });
    expect(errors).toEqual([]);
    expect(flaky).toEqual([{ file: "test/unit/a.test.ts", line: 1, issue: 412 }]);
  });

  it("rejects a flaky title without a reason, and conditional skips", () => {
    expect(run({ "test/unit/a.test.ts": SKIP("flaky #412") }).errors).toHaveLength(1);
    expect(findSkips(`before(function () { if (!key) this${"."}skip(); });`).map((s) => s.kind)).toEqual(["this.skip"]);
    expect(findSkips(`const maybe = ok ? it : it${"."}skip;`).map((s) => s.kind)).toEqual(["skip alias"]);
     // Chained forms skip just as well (review note on #394).
    expect(findSkips(`it${"."}skip${"."}each([1])("x %s", () => {});`).map((s) => s.kind)).toEqual(["chained skip"]);
    expect(findSkips(`it${"."}concurrent${"."}skip("x", () => {});`).map((s) => s.kind)).toEqual(["chained skip"]);
    expect(findSkips(`describe${"."}skip${"."}each([1])("x", () => {});`).map((s) => s.kind)).toEqual(["chained skip"]);
  });

  it("lets live suites gate on the environment", () => {
    expect(run({ "test/live/a.test.ts": SKIP("needs a key") }).errors).toEqual([]);
  });
});
