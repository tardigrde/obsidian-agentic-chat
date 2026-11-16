import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * The verify lanes. Eight names, one per question:
 *
 *   plan     which commands does this diff need?
 *   check    the merge gate (static, unit, build, real-app smoke)
 *   change   one unit file or a -t pattern
 *   app      real Obsidian with scripted turns (specs, mobile, scripted dogfood)
 *   live     real model calls (local only, needs a key)
 *   eval     agentic and tool-use evals
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
  audit: "app test/e2e/specs/design-audit.e2e.ts (with AGENTIC_CHAT_DESIGN_AUDIT=1)",
  all: "release",
};

function bin(name) {
  return path.join("node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

export function step(label, command, args, options = {}) {
  return { label, command, args, expectTests: false, ...options };
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
    step("lint:obsidian", bin("eslint"), ["-c", "config/eslint.obsidian.mjs", "--max-warnings", "0", "src"]),
    step("feature map", NODE, ["scripts/check-feature-map.mjs"]),
    step("test manifest", NODE, ["scripts/check-test-manifest.mjs"]),
    step("doc commands", NODE, ["scripts/check-doc-commands.mjs"]),
    step("skip rule", NODE, ["scripts/check-skips.mjs"]),
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
  });
}

function mobileStep(label, spec) {
  return step(label, NODE, ["scripts/run-e2e-mobile.mjs", "--spec", spec], {
    expectTests: true,
    explainE2eSandboxFailure: true,
  });
}

function scriptedDogfoodStep() {
  return step(
    "scripted dogfood eval",
    NODE,
    ["--import", "tsx", "scripts/run-agentic-evals.ts", "--fail-on-skip", "--run-scripted"],
    { timeoutMs: 30 * 60 * 1000 },
  );
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
 * The `eval` lane serves two runners. A suite belongs to the tool-use runner
 * when it is a file in `test/evals/tool-use/`, named by path or by bare name
 * (`core`, `tool-use`). Returns the suite path, or undefined for an agentic suite.
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

/**
 * Flags that make the agentic runner execute a case it would otherwise skip.
 * With none of them, a skip is the expected result of a no-arg run, so the lane
 * reports it and prints the next command instead of failing.
 */
const AGENTIC_EXECUTE_FLAGS = ["--run-scripted", "--run-judge"];

export const lanes = {
  plan: (args) => [step("plan", NODE, ["scripts/verify-plan.mjs", ...args])],

  check: (input) => {
    const args = [...input];
    const noApp = takeFlag(args, "--no-app");
    const coverage = takeFlag(args, "--coverage");
    if (args.length > 0) throw new Error(`verify check takes --no-app and --coverage, got: ${args.join(" ")}`);
    return [
      ...staticSteps(),
      step(coverage ? "unit tests + coverage report" : "unit tests", bin("vitest"), coverage ? ["run", "--coverage"] : ["run"], {
        expectTests: true,
      }),
      step("witness self-test", NODE, ["scripts/verify-witness.mjs", "--self-test"]),
      ...buildSteps(),
      ...(noApp ? [] : [e2eStep("smoke e2e", [SMOKE_SPEC])]),
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
    return [step("unit tests", bin("vitest"), vitestArgs, { expectTests: true })];
  },

  app: (input) => {
    const args = [...input];
    const mobile = takeFlag(args, "--mobile");
    const dogfood = takeFlag(args, "--dogfood");
    const specs = args.filter((arg) => !arg.startsWith("-")).map((arg) => resolveSpec(arg));
    const passthrough = args.filter((arg) => arg.startsWith("-"));
    const bundle = step("e2e bundle", NODE, ["scripts/build-e2e.mjs"]);
    if (dogfood) {
      return [bundle, scriptedDogfoodStep()];
    }
    if (mobile) {
      const targets = specs.length > 0 ? specs : [MOBILE_SPEC];
      return [bundle, ...targets.map((spec) => mobileStep(`mobile ${path.basename(spec)}`, spec))];
    }
    return [bundle, e2eStep("e2e", specs, { extraArgs: passthrough })];
  },

  live: (args) => {
    if (args.length === 0) {
      return [step("live unit tests", bin("vitest"), ["run", "--config", "vitest.live.config.ts"], { expectTests: true })];
    }
    const specs = args.map((arg) => resolveSpec(arg, LIVE_FIRST));
    if (specs.every((spec) => spec.endsWith(".test.ts"))) {
      return [
        step("live unit tests", bin("vitest"), ["run", "--config", "vitest.live.config.ts", ...specs], {
          expectTests: true,
        }),
      ];
    }
    return [
      step("e2e bundle", NODE, ["scripts/build-e2e.mjs"]),
      e2eStep("live e2e", specs, { env: { AGENTIC_CHAT_LIVE: "1" } }),
    ];
  },

  eval: (args) => {
    const forwarded = args.filter((arg) => arg !== "--fail-on-skip");
    const suite = findSuiteArg(forwarded);
    const toolUseSuite = resolveToolUseSuite(suite?.value);
    if (suite && toolUseSuite) {
      // The runner takes a separate value, so normalize `--suite=<path>`.
      const passthrough = [...forwarded];
      passthrough.splice(suite.index, suite.inline ? 1 : 2, "--suite", toolUseSuite);
      return [step("tool-use evals", NODE, ["--import", "tsx", "scripts/run-tool-use-evals.ts", ...passthrough])];
    }
    // A skip hides unexecuted coverage, so the lane fails on one whenever the
    // caller asked to execute the expensive cases. A plain `verify -- eval`
    // runs what needs no display or key and names the next command.
    const execute = forwarded.some((arg) => AGENTIC_EXECUTE_FLAGS.includes(arg));
    return [
      step("agentic evals", NODE, [
        "--import",
        "tsx",
        "scripts/run-agentic-evals.ts",
        ...(execute ? ["--fail-on-skip"] : []),
        ...forwarded,
      ]),
    ];
  },

  explore: (args) => [
    step("chaos explore", NODE, ["--import", "tsx", "scripts/chaos-monkey.ts", ...args], {
      timeoutMs: 2 * 60 * 60 * 1000,
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
                    production build, real-Obsidian smoke. --no-app drops the smoke
                    (no display); CI runs \`check --no-app --coverage\` plus the app job.
  change <file...|pattern>
                    One or more unit files, or a -t name pattern.
  app [spec...] [--mobile] [--dogfood]
                    Real Obsidian, scripted turns. No spec runs the whole suite;
                    bare names resolve to test/e2e/specs/<name>.e2e.ts.
  live [spec...]    Real model calls. Local only; needs AGENTIC_CHAT_API_KEY.
  eval [args]       Agentic evals (default) or a tool-use suite (--suite core).
  explore [args]    Chaos explore in a throwaway vault. Leads, not proof.
  release           check --no-app, full app suite, mobile specs, scripted dogfood.

Examples:
  npm run verify -- plan
  npm run verify -- check
  npm run verify -- change test/settings.test.ts
  npm run verify -- app settings-ui
  npm run verify -- app --mobile
  npm run verify -- eval --suite core --runs 3
`;
}
