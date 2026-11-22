import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * The verify lanes. Eight names, one per question:
 *
 *   plan     which commands does this diff need?
 *   check    the merge gate (static, unit, build, real-app smoke)
 *   change   one unit file or a -t pattern
 *   app      real Obsidian: specs, --mobile, --dogfood (generated vault), --record (video)
 *   live     real model calls (local only, needs a key)
 *   eval     live tool-use evals (canary, core, regression)
 *   explore  chaos explore in a throwaway vault (leads, not proof)
 *   release  everything deterministic before a release
 *
 * This module only builds step lists; scripts/verify.mjs runs them. Keeping
 * the table importable lets tests pin the lane set and each lane's flags.
 */

const NODE = process.execPath;
// Typecheck with TypeScript 7. The `typescript` package stays on 5.x for
// typescript-eslint, which needs the JS compiler API that TS 7.0 does not ship
// (upstream typescript-eslint#10940).
const TSC7 = path.join("scripts", "tsc7.mjs");
export const SMOKE_SPEC = "test/e2e/specs/smoke.e2e.ts";
export const MOBILE_SPEC = "test/e2e/specs/mobile-viewport.e2e.ts";
export const MOBILE_TWO_TAB_SPEC = "test/e2e/specs/multi-tab-approval.e2e.ts";
const TOOL_USE_SUITE_DIR = "test/evals/tool-use";

export const LANE_NAMES = ["plan", "check", "change", "app", "live", "eval", "explore", "release"];

/**
 * Lanes that were removed in #393 (T08), with the command that replaces each.
 * `verify` prints the replacement instead of "unknown lane", and the doc
 * checker rejects any doc that still names one.
 */
export const RETIRED_LANES = {
  fast: "check",
  ci: "check --no-app --coverage",
  cloud: "check --no-app",
  smoke: "app smoke",
  upgrade: "change test/upgrade-fixtures.test.ts",
  e2e: "app [spec]",
  dogfood: "app --dogfood",
  audit: "app --record layout-smoke (the design audit was deleted in #393 T23)",
  all: "release",
};

function bin(name) {
  return path.join("node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

/**
 * One lane step. `tier` (T0 static, T1 hermetic logic, T2 real app, T3 live,
 * T4 exploration) groups counts in the run result; `vitestJson` asks verify to
 * add a JSON reporter so the history can name individual tests.
 */
export function step(label, command, args, options = {}) {
  return { label, command, args, expectTests: false, tier: "T0", ...options };
}

function takeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

/** Static checks: no build, no test runner. */
export function staticSteps() {
  return [
    step("secret scan", NODE, ["scripts/check-secrets.mjs"]),
    step("typecheck", NODE, [TSC7, "-noEmit"]),
    step("e2e typecheck", NODE, [TSC7, "-p", "tsconfig.e2e.json", "--noEmit"]),
    step("scripts typecheck", NODE, [TSC7, "-p", "config/tsconfig.eslint.json", "--noEmit"]),
    step("lint", bin("eslint"), ["."]),
    step("comment budget (warn)", NODE, ["scripts/comment-budget.mjs"]),
    step("lint:obsidian", bin("eslint"), ["-c", "config/eslint.obsidian.mjs", "--max-warnings", "0", "src"]),
    step("feature map", NODE, ["scripts/check-feature-map.mjs"]),
    step("test manifest", NODE, ["scripts/check-test-manifest.mjs"]),
    step("doc commands", NODE, ["scripts/check-doc-commands.mjs"]),
    step("skip rule", NODE, ["scripts/check-skips.mjs"]),
    step("css tokens", NODE, ["scripts/check-css-tokens.mjs"]),
  ];
}

function buildSteps() {
  return [
    step("production bundle", NODE, ["scripts/build.mjs", "production"]),
    step("release verification", NODE, ["scripts/verify-release.mjs"]),
    step("mobile compatibility", NODE, ["scripts/verify-mobile-compat.mjs"]),
  ];
}

function e2eStep(label, specs, options = {}) {
  const specArgs = specs.flatMap((spec) => ["--spec", spec]);
  return step(label, NODE, ["--import", "tsx", "scripts/run-e2e.ts", ...specArgs, ...(options.extraArgs ?? [])], {
    expectTests: true,
    explainE2eSandboxFailure: true,
    env: options.env,
    tier: options.tier ?? "T2",
    ...(options.mode ? { mode: options.mode } : {}),
  });
}

/**
 * The release bundle (no scripted-turn hook) boots in a real Obsidian: the one
 * smoke test that needs no model. Every other app run uses the e2e bundle.
 */
export const PRODUCTION_BOOT_TEST = "mounts the chat view with a reachable composer and its toolbar";

function productionBootStep() {
  return e2eStep("production boot", [SMOKE_SPEC], { extraArgs: ["--mochaOpts.grep", PRODUCTION_BOOT_TEST] });
}

function mobileStep(label, spec) {
  return step(label, NODE, ["scripts/run-e2e-mobile.mjs", "--spec", spec], {
    expectTests: true,
    explainE2eSandboxFailure: true,
    tier: "T2",
  });
}

function scriptedDogfoodStep() {
  return step(
    "scripted dogfood",
    NODE,
    ["--import", "tsx", "scripts/run-agentic-evals.ts", "--fail-on-skip", "--run-scripted"],
    { timeoutMs: 30 * 60 * 1000, tier: "T2" },
  );
}

/**
 * `app --record <scenario> [--live] [--max-minutes n]`: a recorded run of one
 * probe scenario (video, keyframes, timeline, metrics) on its own display. It
 * must execute at least one test; `--live` only where the scenario drives a
 * real model. Leads for a human, not a gate.
 */
function recordStep(args) {
  const scenario = args.find((arg) => !arg.startsWith("-"));
  if (!scenario) throw new Error("verify app --record needs a scenario, for example: npm run verify -- app --record layout-smoke");
  const rest = args.filter((arg) => arg !== scenario);
  return step(`recorded run ${scenario}`, NODE, ["--import", "tsx", "scripts/probe.ts", "--scenario", scenario, ...rest], {
    expectTests: true,
    tier: "T4",
    mode: rest.includes("--live") ? "live" : "scripted",
    timeoutMs: 30 * 60 * 1000,
  });
}

const SPEC_DIRS = ["test/e2e/specs", "test/e2e/live"];
const LIVE_FIRST = ["test/e2e/live", "test/e2e/specs"];

/**
 * Spec names may be bare (`smoke`) or paths (`test/e2e/specs/smoke.e2e.ts`).
 * A bare name resolves to the first directory that has it.
 */
export function resolveSpec(value, dirs = SPEC_DIRS, cwd = process.cwd()) {
  if (value.includes("/") || value.endsWith(".ts")) return value;
  const found = dirs.map((dir) => `${dir}/${value}.e2e.ts`).find((file) => existsSync(path.resolve(cwd, file)));
  return found ?? `${dirs[0]}/${value}.e2e.ts`;
}

/**
 * A suite is a file in `test/evals/tool-use/`, named by path or by bare name
 * (`core`, `regression`). Returns the suite path, or undefined for anything else.
 */
export function resolveToolUseSuite(value, cwd = process.cwd()) {
  if (!value) return undefined;
  const byName = path.join(TOOL_USE_SUITE_DIR, `${value}.eval.json`);
  if (path.basename(value) === value && existsSync(path.resolve(cwd, byName))) return byName;
  const relative = path.relative(path.resolve(cwd, TOOL_USE_SUITE_DIR), path.resolve(cwd, value));
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  return inside ? value : undefined;
}

function findSuiteArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--suite") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return undefined;
      return { index, value, inline: false };
    }
    if (arg.startsWith("--suite=")) {
      return { index, value: arg.slice("--suite=".length), inline: true };
    }
  }
  return undefined;
}

export const lanes = {
  plan: (args) => [step("plan", NODE, ["scripts/verify-plan.mjs", ...args], { record: false })],

  check: (input) => {
    const args = [...input];
    const noApp = takeFlag(args, "--no-app");
    const coverage = takeFlag(args, "--coverage");
    if (args.length > 0) throw new Error(`verify check takes --no-app and --coverage, got: ${args.join(" ")}`);
    return [
      ...staticSteps(),
      step(coverage ? "unit tests + coverage report" : "unit tests", bin("vitest"), coverage ? ["run", "--coverage"] : ["run"], {
        expectTests: true,
        tier: "T1",
        vitestJson: true,
      }),
      step("witness self-test", NODE, ["scripts/verify-witness.mjs", "--self-test"], { tier: "T1" }),
      ...buildSteps(),
      ...(noApp ? [] : [productionBootStep(), step("e2e bundle", NODE, ["scripts/build-e2e.mjs"]), e2eStep("smoke e2e", [SMOKE_SPEC])]),
    ];
  },

  change: (args) => {
    if (args.length === 0) {
      throw new Error(
        "verify change needs a test file or a -t pattern, for example: npm run verify -- change test/settings.test.ts",
      );
    }
    const isPath = (target) => target.includes("/") || target.endsWith(".test.ts");
    // Several files run together; anything else is one -t name pattern.
    const vitestArgs = args.every(isPath)
      ? ["run", "--reporter=default", ...args]
      : ["run", "--reporter=default", "-t", args.join(" ")];
    return [step("unit tests", bin("vitest"), vitestArgs, { expectTests: true, tier: "T1", vitestJson: true })];
  },

  app: (input) => {
    const args = [...input];
    const record = takeFlag(args, "--record");
    if (record) return [recordStep(args)];
    const mobile = takeFlag(args, "--mobile");
    const dogfood = takeFlag(args, "--dogfood");
    const prod = takeFlag(args, "--prod");
    // CI builds the e2e bundle once and reuses it for the next app step.
    const reuse = takeFlag(args, "--reuse-bundle");
    const specs = args.filter((arg) => !arg.startsWith("-")).map((arg) => resolveSpec(arg));
    const passthrough = args.filter((arg) => arg.startsWith("-"));
    const bundle = reuse ? [] : [step("e2e bundle", NODE, ["scripts/build-e2e.mjs"])];
    if (dogfood) {
      return [...bundle, scriptedDogfoodStep()];
    }
    if (prod) {
      return [step("production bundle", NODE, ["scripts/build.mjs", "production"]), productionBootStep()];
    }
    if (mobile) {
      const targets = specs.length > 0 ? specs : [MOBILE_SPEC];
      return [...bundle, ...targets.map((spec) => mobileStep(`mobile ${path.basename(spec)}`, spec))];
    }
    return [...bundle, e2eStep("e2e", specs, { extraArgs: passthrough })];
  },

  live: (args) => {
    if (args.length === 0) {
      return [
        step("live unit tests", bin("vitest"), ["run", "--config", "vitest.live.config.ts"], { expectTests: true, tier: "T3", mode: "live" }),
      ];
    }
    const specs = args.map((arg) => resolveSpec(arg, LIVE_FIRST));
    if (specs.every((spec) => spec.endsWith(".test.ts"))) {
      return [
        step("live unit tests", bin("vitest"), ["run", "--config", "vitest.live.config.ts", ...specs], {
          expectTests: true,
          tier: "T3",
          mode: "live",
        }),
      ];
    }
    return [
      step("e2e bundle", NODE, ["scripts/build-e2e.mjs"]),
      e2eStep("live e2e", specs, { env: { AGENTIC_CHAT_LIVE: "1" }, tier: "T3", mode: "live" }),
    ];
  },

  eval: (input) => {
    // One runner: the live tool-use suites in test/evals/tool-use (core,
    // regression). With no arguments the lane prints the core plan and spends
    // nothing; any argument runs the suite for real.
    const args = [...input];
    const suite = findSuiteArg(args);
    let suitePath = path.join(TOOL_USE_SUITE_DIR, "core.eval.json");
    if (suite) {
      const resolved = resolveToolUseSuite(suite.value);
      if (!resolved) throw new Error(`verify eval: --suite ${suite.value} is not a suite in ${TOOL_USE_SUITE_DIR} (core, regression)`);
      suitePath = resolved;
      args.splice(suite.index, suite.inline ? 1 : 2);
    }
    const dryRun = input.length === 0;
    return [
      step("tool-use evals", NODE, ["--import", "tsx", "scripts/run-tool-use-evals.ts", "--suite", suitePath, ...(dryRun ? ["--dry-run"] : args)], {
        tier: "T3",
        mode: dryRun ? "static" : "live",
        record: !dryRun,
      }),
    ];
  },

  explore: (args) => [
    step("chaos explore", NODE, ["--import", "tsx", "scripts/chaos-monkey.ts", ...args], {
      timeoutMs: 2 * 60 * 60 * 1000,
      tier: "T4",
      mode: args.includes("--live") ? "live" : "scripted",
    }),
  ],

  release: (args) => {
    if (args.length > 0) throw new Error(`verify release takes no arguments, got: ${args.join(" ")}`);
    return [
      ...lanes.check(["--no-app"]),
      step("e2e bundle", NODE, ["scripts/build-e2e.mjs"]),
      e2eStep("e2e", []),
      mobileStep("mobile viewport", MOBILE_SPEC),
      mobileStep("mobile two-tab", MOBILE_TWO_TAB_SPEC),
      scriptedDogfoodStep(),
    ];
  },
};

export function usage() {
  return `Usage: npm run verify -- <lane> [args]

Lanes: ${LANE_NAMES.join(", ")}

  plan [--base <ref>] [--json] [--explain <path>] [--run]
                    Read the diff and print the exact commands it needs. Run it first.
  check [--no-app] [--coverage]
                    Merge gate: secret scan, typecheck, lints, feature map, test
                    manifest, doc commands, skip rule, unit, witness self-test,
                    production build, production boot, e2e smoke. --no-app drops the app steps
                    (no display); CI runs \`check --no-app --coverage\` plus the app job.
  change <file...|pattern>
                    One or more unit files, or a -t name pattern.
  app [spec...] [--mobile] [--dogfood] [--prod] [--reuse-bundle]
                    Real Obsidian, scripted turns. No spec runs the whole suite;
                    bare names resolve to test/e2e/specs/<name>.e2e.ts.
                    --dogfood: the generated vault with its invariant oracle.
  app --record <scenario> [--live] [--max-minutes n]
                    A recorded run (video, keyframes, metrics) of one scenario in
                    test/e2e/probe/scenarios. Must execute a test.
  live [spec...]    Real model calls. Local only; needs AGENTIC_CHAT_API_KEY.
  eval [args]       Live tool-use evals (--suite core|regression, --canary, --runs N,
                    --parallel N). No arguments: print the core plan, no model call.
  explore [--mode explore|smoke] [--live] [--charter c]
                    Chaos explore in a throwaway vault (smoke: a dry run, the
                    default). Leads, not proof.
  release           check --no-app, full app suite, mobile specs, scripted dogfood.

Examples:
  npm run verify -- plan
  npm run verify -- check
  npm run verify -- change test/settings.test.ts
  npm run verify -- app settings-ui
  npm run verify -- app --mobile
  npm run verify -- app --record layout-smoke
  npm run verify -- eval --canary
  npm run verify -- eval --suite core --runs 3
`;
}
