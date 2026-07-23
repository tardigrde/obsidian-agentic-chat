import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { hasAnyEnv, loadEnvFileFromArgs } from "./live-env.mjs";

const liveProviderSpecs = [
  {
    label: "OpenAI-compatible guardrail flow",
    spec: "test/e2e/specs/guardrails.e2e.ts",
    env: ["AGENTIC_CHAT_API_KEY", "AGENTIC_CHAT_API_KEY_FILE"],
    command: "AGENTIC_CHAT_API_KEY=... AGENTIC_CHAT_BASE_URL=... AGENTIC_CHAT_MODEL=... npm run test:e2e -- --spec test/e2e/specs/guardrails.e2e.ts",
  },
  {
    label: "OpenAI-compatible live flow",
    spec: "test/e2e/specs/openwebui-live.e2e.ts",
    env: ["AGENTIC_CHAT_API_KEY", "AGENTIC_CHAT_API_KEY_FILE"],
    command:
      "AGENTIC_CHAT_API_KEY=... AGENTIC_CHAT_BASE_URL=... AGENTIC_CHAT_MODEL=... npm run test:e2e -- --spec test/e2e/specs/openwebui-live.e2e.ts",
  },
];

const liveProviderScripts = [
  {
    label: "OpenAI-compatible provider-cache flow",
    script: "scripts/eval-provider-cache-live.mjs",
    npmScript: "eval:provider-cache-live",
    env: [
      "AGENTIC_CHAT_API_KEY",
      "AGENTIC_CHAT_API_KEY_FILE",
    ],
    command:
      "AGENTIC_CHAT_API_KEY=... AGENTIC_CHAT_BASE_URL=... AGENTIC_CHAT_MODEL=... npm run eval:provider-cache-live",
  },
];

function readText(path) {
  return readFileSync(path, "utf8");
}

function validateConfiguredGate() {
  const failures = [];
  const readme = existsSync("README.md") ? readText("README.md") : "";

  if (!readme.includes("npm run verify:provider-live")) {
    failures.push("README.md does not point release validators at npm run verify:provider-live");
  }

  for (const liveSpec of liveProviderSpecs) {
    if (!existsSync(liveSpec.spec)) {
      failures.push(`${liveSpec.spec} does not exist`);
      continue;
    }
    const specText = readText(liveSpec.spec);
    if (!specText.includes("this.skip()")) {
      failures.push(`${liveSpec.spec} must skip when its live credential is absent`);
    }
    for (const envName of liveSpec.env) {
      if (!specText.includes(envName)) {
        failures.push(`${liveSpec.label} does not document or check ${envName}`);
      }
    }
  }

  const packageJson = existsSync("package.json") ? readText("package.json") : "";
  for (const liveScript of liveProviderScripts) {
    if (!existsSync(liveScript.script)) {
      failures.push(`${liveScript.script} does not exist`);
      continue;
    }
    const scriptText = readText(liveScript.script);
    if (!scriptText.includes("--check")) {
      failures.push(`${liveScript.script} must support --check`);
    }
    if (!packageJson.includes(`"${liveScript.npmScript}"`)) {
      failures.push(`package.json does not expose npm run ${liveScript.npmScript}`);
    }
  }

  return failures;
}

function missingCredentials(env) {
  return [...liveProviderSpecs, ...liveProviderScripts].filter((liveSpec) => !hasAnyEnv(env, liveSpec.env));
}

function runSpec(spec) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "test:e2e", "--", "--spec", spec], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runNpmScript(script) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", script], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const checkOnly = process.argv.includes("--check");
loadEnvFileFromArgs();
const gateFailures = validateConfiguredGate();
if (gateFailures.length > 0) {
  console.error(gateFailures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

if (checkOnly) {
  process.stdout.write("Live provider gate configured.\n");
  process.exit(0);
}

const missing = missingCredentials(process.env);
if (missing.length > 0) {
  console.error("Live provider validation requires credentials for every provider path:");
  for (const liveSpec of missing) {
    console.error(`- ${liveSpec.label}: set one of ${liveSpec.env.join(" or ")}`);
    console.error(`  ${liveSpec.command}`);
  }
  process.exit(1);
}

for (const liveSpec of liveProviderSpecs) runSpec(liveSpec.spec);
for (const liveScript of liveProviderScripts) runNpmScript(liveScript.npmScript);
