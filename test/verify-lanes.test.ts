import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LANE_NAMES, RETIRED_LANES, lanes, resolveSpec } from "../scripts/verify-lanes.mjs";

type Step = { label: string; command: string; args: string[]; expectTests: boolean; env?: Record<string, string> };
const build = (name: string, args: string[] = []) => (lanes as Record<string, (a: string[]) => Step[]>)[name](args);
const labels = (steps: Step[]) => steps.map((s) => s.label);

describe("verify lanes", () => {
  it("has exactly the eight lanes of #393", () => {
    expect(Object.keys(lanes)).toEqual(LANE_NAMES);
    expect(LANE_NAMES).toEqual(["plan", "check", "change", "app", "live", "eval", "explore", "release"]);
    for (const retired of Object.keys(RETIRED_LANES)) expect(LANE_NAMES).not.toContain(retired);
  });

  it("eval with no arguments prints the core plan and spends nothing", () => {
    const [plain] = build("eval");
    expect(plain.args).toEqual(["--import", "tsx", "scripts/run-tool-use-evals.ts", "--suite", path.join("test/evals/tool-use", "core.eval.json"), "--dry-run"]);
    expect(build("eval", ["--canary"])[0].args).toEqual(expect.arrayContaining(["--canary"]));
    expect(build("eval", ["--canary"])[0].args).not.toContain("--dry-run");
    expect(() => build("eval", ["--suite", "tool-use"])).toThrow(/not a suite/);
  });

  it("routes a tool-use suite by name to the tool-use runner", () => {
    const steps = build("eval", ["--suite=core", "--runs", "3"]);
    expect(steps[0].args).toEqual([
      "--import",
      "tsx",
      "scripts/run-tool-use-evals.ts",
      "--suite",
      path.join("test/evals/tool-use", "core.eval.json"),
      "--runs",
      "3",
    ]);
  });

  it("check keeps the real-app smoke unless --no-app, and --coverage switches the unit step", () => {
    const full = labels(build("check"));
    expect(full.at(-1)).toBe("smoke e2e");
    for (const required of ["secret scan", "typecheck", "scripts typecheck", "test manifest", "doc commands", "skip rule", "unit tests", "witness self-test", "production bundle"]) {
      expect(full).toContain(required);
    }
    // The release bundle boots first (no scripted hook), then the smoke runs
    // on the e2e bundle, which has the scripted-turn hook it needs.
    expect(full.slice(-3)).toEqual(["production boot", "e2e bundle", "smoke e2e"]);
    expect(full.indexOf("production bundle")).toBeLessThan(full.indexOf("production boot"));
    const ci = labels(build("check", ["--no-app", "--coverage"]));
    expect(ci).not.toContain("smoke e2e");
    expect(ci).not.toContain("production boot");
    expect(ci).toContain("unit tests + coverage report");
    expect(() => build("check", ["--bogus"])).toThrow(/--no-app/);
  });

  it("app resolves bare spec names and has mobile and dogfood modes", () => {
    expect(resolveSpec("smoke")).toBe("test/e2e/specs/smoke.e2e.ts");
    expect(build("app", ["smoke"])[1].args).toContain("test/e2e/specs/smoke.e2e.ts");
    expect(labels(build("app", ["--mobile"]))).toEqual(["e2e bundle", "mobile mobile-viewport.e2e.ts"]);
    expect(labels(build("app", ["--mobile", "--reuse-bundle"]))).toEqual(["mobile mobile-viewport.e2e.ts"]);
    const prod = build("app", ["--prod"]);
    expect(labels(prod)).toEqual(["production bundle", "production boot"]);
    expect(prod[1].args).toEqual(expect.arrayContaining(["--spec", "test/e2e/specs/smoke.e2e.ts", "--mochaOpts.grep"]));
    expect(build("app", ["--dogfood"])[1].args).toEqual(
      expect.arrayContaining(["scripts/run-agentic-evals.ts", "--fail-on-skip", "--run-scripted"]),
    );
  });

  it("live sets AGENTIC_CHAT_LIVE for e2e specs", () => {
    const steps = build("live", ["openwebui-live"]);
    expect(steps[1].env).toEqual({ AGENTIC_CHAT_LIVE: "1" });
    expect(steps[1].args).toContain("test/e2e/live/openwebui-live.e2e.ts");
  });

  it(
    "`verify -- eval` exits 0 on a clean checkout without a key and prints the plan",
    () => {
      const result = spawnSync(process.execPath, ["scripts/verify.mjs", "eval"], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, AGENTIC_CHAT_HISTORY: "0", AGENTIC_CHAT_API_KEY: "" },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain("Tool-use eval plan: core");
      expect(output).toContain("12 case(s) x 3 run(s)");
    },
    60_000,
  );

  it("a retired lane names its replacement", () => {
    const result = spawnSync(process.execPath, ["scripts/verify.mjs", "fast"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("npm run verify -- check");
  });
});

describe("change lane", () => {
  it("runs several files together, or one name pattern", () => {
    expect(build("change", ["test/a.test.ts", "test/b.test.ts"])[0].args).toEqual([
      "run",
      "--reporter=default",
      "test/a.test.ts",
      "test/b.test.ts",
    ]);
    expect(build("change", ["uses", "the", "model"])[0].args).toEqual(["run", "--reporter=default", "-t", "uses the model"]);
  });
});
