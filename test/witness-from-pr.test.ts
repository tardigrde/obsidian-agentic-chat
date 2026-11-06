import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractWitnessBlock,
  parseWitnessBlock,
  validateWitnessSpec,
  witnessDecision,
} from "../scripts/witness-from-pr.mjs";

describe("witness-from-pr", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "witness-pr-"));
    mkdirSync(path.join(root, "test"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "test", "a.test.ts"), "export {};\n");
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads an HTML comment block and a fenced block", () => {
    expect(extractWitnessBlock("<!-- witness\ntest: test/a.test.ts\n-->")).toContain(
      "test: test/a.test.ts",
    );
    expect(extractWitnessBlock("```witness\ntest: test/a.test.ts\n```")).toContain(
      "test: test/a.test.ts",
    );
  });

  it("skips a PR with no witness block and no behavior label", () => {
    expect(witnessDecision({ body: "no evidence here", labels: [], root })).toMatchObject({
      action: "skip",
    });
  });

  it("fails a behavior PR with no witness block", () => {
    expect(witnessDecision({ body: "no evidence here", labels: ["behavior"], root })).toMatchObject({
      action: "fail",
    });
  });

  it("skips an empty template block unless the behavior label is set", () => {
    const body = "<!-- witness\n\n-->";
    expect(witnessDecision({ body, labels: [], root })).toMatchObject({ action: "skip" });
    expect(witnessDecision({ body, labels: ["behavior"], root })).toMatchObject({ action: "fail" });
  });

  it("accepts one test file and several sources", () => {
    writeFileSync(path.join(root, "src", "b.ts"), "export const b = 2;\n");
    const decision = witnessDecision({
      body: "<!-- witness\ntest: test/a.test.ts\nsrc: src/a.ts\nsrc: src/b.ts\n-->",
      labels: [],
      root,
    });
    expect(decision).toMatchObject({
      action: "run",
      spec: { testFile: "test/a.test.ts", sources: ["src/a.ts", "src/b.ts"] },
    });
    if (decision.action !== "run") throw new Error("expected a run decision");
    expect(decision.spec.sources).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("ignores a base chosen by the PR", () => {
    const decision = witnessDecision({
      body: "<!-- witness\ntest: test/a.test.ts\nsrc: src/a.ts\nbase: HEAD~5\n-->",
      labels: [],
      root,
    });
    expect(decision).toMatchObject({ action: "run" });
    if (decision.action !== "run") throw new Error("expected a run decision");
    expect(decision.spec).not.toHaveProperty("base");
  });

  it("rejects a command instead of a test file", () => {
    const decision = witnessDecision({
      body: "<!-- witness\ntest: npm run verify -- ci\nsrc: src/a.ts\n-->",
      labels: [],
      root,
    });
    expect(decision.action).toBe("fail");
    if (decision.action !== "fail") throw new Error("expected a fail decision");
    expect(decision.reason).toContain("outside test/");
  });

  it("rejects missing files and paths outside the repo", () => {
    for (const block of [
      "test: test/missing.test.ts\nsrc: src/a.ts",
      "test: test/a.test.ts\nsrc: src/missing.ts",
      "test: test/a.test.ts\nsrc: ../src/a.ts",
      "test: /etc/passwd\nsrc: src/a.ts",
    ]) {
      expect(validateWitnessSpec(parseWitnessBlock(block), root).length).toBeGreaterThan(0);
    }
  });

  it("rejects two test files and unknown keys", () => {
    expect(
      validateWitnessSpec(
        parseWitnessBlock("test: test/a.test.ts\ntest: test/b.test.ts\nsrc: src/a.ts"),
        root,
      ),
    ).toContain("name exactly one test file");
    expect(validateWitnessSpec(parseWitnessBlock("nope: value"), root)).toContain(
      'unknown key "nope"',
    );
  });
});
