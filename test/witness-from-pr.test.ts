import { execFileSync, spawnSync } from "node:child_process";
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

const CLI = path.resolve("scripts/witness-from-pr.mjs");

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

  it("uses a filled block after the empty template block", () => {
    const body = [
      "<!-- witness",
      "# test: test/example.test.ts",
      "# src: src/example.ts",
      "-->",
      "",
      "<!-- witness",
      "test: test/a.test.ts",
      "src: src/a.ts",
      "-->",
    ].join("\n");
    expect(witnessDecision({ body, labels: [], root, changedFiles: ["src/a.ts"] })).toMatchObject({
      action: "run",
    });
  });

  it("rejects several different filled blocks", () => {
    const body = [
      "<!-- witness",
      "test: test/a.test.ts",
      "src: src/a.ts",
      "-->",
      "<!-- witness",
      "test: test/a.test.ts",
      "src: src/b.ts",
      "-->",
    ].join("\n");
    expect(witnessDecision({ body, labels: [], root, changedFiles: ["src/a.ts"] })).toMatchObject({
      action: "fail",
    });
  });

  it("requires a witness for a source change unless the PR opts out", () => {
    expect(
      witnessDecision({ body: "none", labels: [], root, changedFiles: ["src/a.ts"] }),
    ).toMatchObject({ action: "fail" });
    expect(
      witnessDecision({
        body: "none",
        labels: [],
        root,
        changedFiles: ["src/vendor/fflate.js"],
      }),
    ).toMatchObject({ action: "fail" });
    expect(
      witnessDecision({
        body: "none",
        labels: [],
        root,
        changedFiles: ["src/café.ts"],
      }),
    ).toMatchObject({ action: "fail" });
    expect(
      witnessDecision({
        body: "none",
        labels: ["no-behavior-change"],
        root,
        changedFiles: ["src/a.ts"],
      }),
    ).toMatchObject({ action: "skip" });
    expect(
      witnessDecision({ body: "none", labels: [], root, changedFiles: ["docs/a.md"] }),
    ).toMatchObject({ action: "skip" });
  });

  it("accepts a non-TypeScript source under src/", () => {
    writeFileSync(path.join(root, "src", "vendor.js"), "export const a = 1;\n");
    expect(
      witnessDecision({
        body: "<!-- witness\ntest: test/a.test.ts\nsrc: src/vendor.js\n-->",
        labels: [],
        root,
      }),
    ).toMatchObject({ action: "run" });
  });

  it("exits non-zero for invalid evidence and a missing base", () => {
    const env = { ...process.env, PR_BODY: "no block", PR_LABELS: "", BASE_SHA: "HEAD" };
    const skipped = spawnSync(process.execPath, [CLI], { cwd: process.cwd(), env, encoding: "utf8" });
    expect(skipped.status, skipped.stderr).toBe(0);
    expect(skipped.stdout).toContain("skipped");

    const invalid = spawnSync(process.execPath, [CLI], {
      cwd: process.cwd(),
      env: {
        ...env,
        PR_BODY:
          "<!-- witness\ntest: npm run verify -- ci\nsrc: src/agent/agent-service.ts\n-->",
      },
      encoding: "utf8",
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("outside test/");

    const missingBase = spawnSync(process.execPath, [CLI], {
      cwd: process.cwd(),
      env: { ...env, BASE_SHA: "" },
      encoding: "utf8",
    });
    expect(missingBase.status).toBe(1);
    expect(missingBase.stderr).toContain("BASE_SHA");
  });

  it("runs the verifier next to itself, not the one in the measured checkout", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "witness-trusted-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
      git("init");
      git("config", "user.email", "witness@example.test");
      git("config", "user.name", "Witness Test");
      mkdirSync(path.join(repo, "src"), { recursive: true });
      mkdirSync(path.join(repo, "test"), { recursive: true });
      writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
      writeFileSync(path.join(repo, "test", "a.test.ts"), "export {};\n");
      git("add", ".");
      git("commit", "-m", "base");
      const base = git("rev-parse", "HEAD").toString().trim();
      // The PR plants its own verifier that always reports success.
      mkdirSync(path.join(repo, "scripts"), { recursive: true });
      writeFileSync(
        path.join(repo, "scripts", "verify-witness.mjs"),
        'console.log("PLANTED VERIFIER"); process.exit(0);\n',
      );
      writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
      git("add", ".");
      git("commit", "-m", "change");

      const result = spawnSync(process.execPath, [CLI], {
        cwd: repo,
        env: {
          ...process.env,
          PR_BODY: "<!-- witness\ntest: test/a.test.ts\nsrc: src/a.ts\n-->",
          PR_LABELS: "",
          BASE_SHA: base,
        },
        encoding: "utf8",
      });
      expect(result.stdout).not.toContain("PLANTED VERIFIER");
      expect(result.stdout).toContain("verify-witness:");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits non-zero when a source change has no witness", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "witness-cli-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
      git("init");
      git("config", "user.email", "witness@example.test");
      git("config", "user.name", "Witness Test");
      mkdirSync(path.join(repo, "src"), { recursive: true });
      writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
      git("add", ".");
      git("commit", "-m", "base");
      const base = git("rev-parse", "HEAD").toString().trim();
      writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
      git("add", ".");
      git("commit", "-m", "change");

      const result = spawnSync(process.execPath, [CLI], {
        cwd: repo,
        env: { ...process.env, PR_BODY: "none", PR_LABELS: "", BASE_SHA: base },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("changes src/a.ts");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("detects a non-ASCII JavaScript source and a move out of src/", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "witness-cli-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
      git("init");
      git("config", "user.email", "witness@example.test");
      git("config", "user.name", "Witness Test");
      mkdirSync(path.join(repo, "src"), { recursive: true });
      writeFileSync(path.join(repo, "src", "café.js"), "export const a = 1;\n");
      writeFileSync(path.join(repo, "src", "move.ts"), "export const b = 1;\n");
      git("add", ".");
      git("commit", "-m", "base");
      const base = git("rev-parse", "HEAD").toString().trim();

      writeFileSync(path.join(repo, "src", "café.js"), "export const a = 2;\n");
      git("add", ".");
      git("commit", "-m", "change non-ascii");
      const nonAscii = spawnSync(process.execPath, [CLI], {
        cwd: repo,
        env: { ...process.env, PR_BODY: "none", PR_LABELS: "", BASE_SHA: base },
        encoding: "utf8",
      });
      expect(nonAscii.status, nonAscii.stderr).toBe(1);
      expect(nonAscii.stderr).toContain("changes src/café.js");

      const moveBase = git("rev-parse", "HEAD").toString().trim();
      mkdirSync(path.join(repo, "docs"), { recursive: true });
      git("mv", "src/move.ts", "docs/move.ts");
      git("commit", "-m", "move out of src");
      const moved = spawnSync(process.execPath, [CLI], {
        cwd: repo,
        env: { ...process.env, PR_BODY: "none", PR_LABELS: "", BASE_SHA: moveBase },
        encoding: "utf8",
      });
      expect(moved.status, moved.stderr).toBe(1);
      expect(moved.stderr).toContain("changes src/move.ts");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
