import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const liveProviderSpecs = [
  {
    label: "OpenRouter guardrail flow",
    spec: "test/e2e/specs/guardrails.e2e.ts",
    env: ["OPENROUTER_API_KEY"],
    command: "OPENROUTER_API_KEY=... npm run test:e2e -- --spec test/e2e/specs/guardrails.e2e.ts",
  },
  {
    label: "OpenAI-compatible OpenWebUI flow",
    spec: "test/e2e/specs/openwebui-live.e2e.ts",
    env: ["OPENWEBUI_API_KEY", "OPENWEBUI_API_KEY_FILE"],
    command:
      "OPENWEBUI_API_KEY_FILE=/tmp/llm-chat.api-key OPENWEBUI_BASE_URL=... OPENWEBUI_MODEL=... npm run test:e2e -- --spec test/e2e/specs/openwebui-live.e2e.ts",
  },
];

function readText(path) {
  return readFileSync(path, "utf8");
}

function hasAnyEnv(env, names) {
  return names.some((name) => typeof env[name] === "string" && env[name].trim().length > 0);
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

  return failures;
}

function missingCredentials(env) {
  return liveProviderSpecs.filter((liveSpec) => !hasAnyEnv(env, liveSpec.env));
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

const checkOnly = process.argv.includes("--check");
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
