import { describe, expect, it } from "vitest";
import { listTestFiles, loadManifest } from "../scripts/check-test-manifest.mjs";
import { planFor, relatedUnitTests } from "../scripts/verify-plan.mjs";

const manifest = loadManifest();
const testFiles = listTestFiles(manifest);
const commands = (files: string[]) => planFor(files, manifest, testFiles).steps.map((step) => step.command);

describe("verify plan", () => {
  it("docs only: check plus the docs build", () => {
    expect(commands(["docs/development/testing.md"])).toEqual(["npm run docs:build", "npm run verify -- check"]);
  });

  it("test only: the changed unit test, then check", () => {
    expect(commands(["test/settings.test.ts"])).toEqual([
      "npm run verify -- change test/settings.test.ts",
      "npm run verify -- check",
    ]);
  });

  it("src/ui: related unit tests, check, the full app suite, and mobile", () => {
    const planned = commands(["src/ui/chat-view.ts"]);
    expect(planned[0]).toMatch(/^npm run verify -- change .*test\/chat-view-lifecycle\.test\.ts/);
    expect(planned).toContain("npm run verify -- check");
    expect(planned).toContain("npm run verify -- app");
    expect(planned).toContain("npm run verify -- app --mobile");
    expect(planned.indexOf("npm run verify -- check")).toBeLessThan(planned.indexOf("npm run verify -- app"));
  });

  it("src/agent prompt: scripted dogfood and the live eval, marked live", () => {
    const plan = planFor(["src/agent/default-system-prompt.ts"], manifest, testFiles);
    const planned = plan.steps.map((step) => step.command);
    expect(planned).toContain("npm run verify -- app --dogfood");
    const evalStep = plan.steps.find((step) => step.command.startsWith("npm run verify -- eval"));
    expect(evalStep?.live).toBe(true);
    expect(planned.at(-1)).toBe(evalStep?.command);
  });

  it("scripts/: the script's own test, then check; no app", () => {
    expect(commands(["scripts/verify-witness.mjs"])).toEqual([
      "npm run verify -- change test/verify-witness.test.ts",
      "npm run verify -- check",
    ]);
  });

  it("a deleted spec plans no run of that spec", () => {
    const plan = planFor(["test/e2e/specs/gone.e2e.ts"], manifest, testFiles, () => false);
    expect(plan.steps.map((step) => step.command)).not.toContain("npm run verify -- app test/e2e/specs/gone.e2e.ts");
  });

  it("package.json: check plus the full app suite", () => {
    expect(commands(["package.json"])).toEqual(["npm run verify -- check", "npm run verify -- app"]);
  });

  it("an unknown src/ path never plans less than unit + app", () => {
    const planned = commands(["src/brand-new-area/thing.ts"]);
    expect(planned).toEqual(expect.arrayContaining(["npm run verify -- check", "npm run verify -- app"]));
  });

  it("a big change proposes chaos explore, never runs it", () => {
    const files = Array.from({ length: 15 }, (_, index) => `src/agent/file-${index}.ts`);
    const plan = planFor(files, manifest, testFiles);
    expect(plan.proposals[0]).toContain("verify -- explore");
    expect(plan.steps.map((step) => step.command).some((cmd) => cmd.includes("explore"))).toBe(false);
  });

  it("relates a source file to unit tests by name", () => {
    expect(relatedUnitTests("src/ui/chat-view.ts", ["test/chat-view-tabs.test.ts", "test/chat-tab-state.test.ts"])).toEqual([
      "test/chat-view-tabs.test.ts",
    ]);
  });
});
