import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectSecrets,
  createLineRedactor,
  createRedactor,
  redactText,
} from "../scripts/redact-log.mjs";

// Build every fixture key from parts. A tracked file must never hold a literal
// that `npm run check:secrets` would flag.
const OPENROUTER_KEY = ["sk", "or", "v1", "a1b2c3d4e5f6g7h8i9j0k1l2"].join("-");
const OPENCODE_KEY = ["oc", "sk", "a1b2c3d4e5f6g7h8i9j0"].join("_");
const GITHUB_TOKEN = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
const GENERIC_KEY = ["sk", "proj", "a1b2c3d4e5f6g7h8i9j0k1l2"].join("-");
const EXACT_ENV_VALUE = ["local", "secret", "value", "123456"].join("-");
const ENV_FILE_VALUE = ["env", "file", "value", "987654"].join("-");
const SINK_SECRET = ["sink", "secret", "value", "123456789"].join("-");
const SPLIT_SECRET = ["split", "secret", "value", "0123456789"].join("-");

const SCRIPT = fileURLToPath(new URL("../scripts/redact-log.mjs", import.meta.url));

const secrets = collectSecrets({ AGENTIC_CHAT_TEST_API_KEY: EXACT_ENV_VALUE }, "");

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "redact-log-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// verify.mjs and the modules it imports, relative to scripts/.
const VERIFY_MODULES = ["verify.mjs", "verify-lanes.mjs", "redact-log.mjs"];

function makeVerifyRoot() {
  const root = tempDir();
  const scriptsDir = path.join(root, "scripts");
  const binDir = path.join(root, "node_modules", ".bin");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  for (const name of VERIFY_MODULES) {
    mkdirSync(path.dirname(path.join(scriptsDir, name)), { recursive: true });
    writeFileSync(
      path.join(scriptsDir, name),
      readFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), "utf8"),
    );
  }
  return { root, scriptsDir, binDir };
}

function writeFakeVitest(binDir: string, source: string) {
  const fake = path.join(binDir, "vitest");
  writeFileSync(fake, source);
  chmodSync(fake, 0o755);
  return fake;
}

function runVerify(root: string, scriptsDir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(scriptsDir, "verify.mjs"), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function unitTestLog(root: string): string {
  const stamp = readdirSync(path.join(root, "logs", "verify"))[0];
  const dir = path.join(root, "logs", "verify", stamp);
  const name = readdirSync(dir).find((entry) => entry.endsWith("-unit-tests.log"));
  if (!name) throw new Error("no unit test log");
  return readFileSync(path.join(dir, name), "utf8");
}

describe("redact-log", () => {
  it("redacts exact env values and known key shapes, and keeps normal text", () => {
    const line = [
      `request={"authorization":"Bearer ${OPENROUTER_KEY}",`,
      `"opencode":"${OPENCODE_KEY}",`,
      `"github":"${GITHUB_TOKEN}",`,
      `"generic":"${GENERIC_KEY}",`,
      `"password":"${EXACT_ENV_VALUE}"}`,
      "POST /api/v1/chat/completions completed in 120ms; risk-assessment ok",
    ].join(" ");

    const output = redactText(line, secrets);

    expect(output).toContain("[REDACTED_OPENROUTER_KEY]");
    expect(output).toContain("[REDACTED_OPENCODE_KEY]");
    expect(output).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(output).toContain("[REDACTED_SECRET]");
    expect(output).toContain("POST /api/v1/chat/completions completed in 120ms");
    expect(output).toContain("risk-assessment ok");
    for (const value of [OPENROUTER_KEY, OPENCODE_KEY, GITHUB_TOKEN, GENERIC_KEY, EXACT_ENV_VALUE]) {
      expect(output).not.toContain(value);
    }
  });

  it("catches a key split across a chunk boundary with the line buffer", () => {
    const line = `{"key":"${OPENROUTER_KEY}"}\nnext line\n`;
    const buffer = createLineRedactor((text) => redactText(text, secrets));

    const first = buffer.push(line.slice(0, 14));
    const second = buffer.push(line.slice(14));

    expect(first).toBe("");
    expect(first + second).toContain("[REDACTED_OPENROUTER_KEY]");
    expect(first + second).not.toContain(OPENROUTER_KEY);
    expect(first + second).toContain("next line");
    expect(buffer.flush()).toBe("");
  });

  it("flushes a final line that has no newline", () => {
    const buffer = createLineRedactor((text) => redactText(text, secrets));

    expect(buffer.push(`tail ${OPENCODE_KEY}`)).toBe("");
    expect(buffer.flush()).toContain("[REDACTED_OPENCODE_KEY]");
  });

  it("builds the secret list from the environment and .env text", () => {
    const list = collectSecrets(
      { AGENTIC_CHAT_TEST_API_KEY: EXACT_ENV_VALUE, AGENTIC_CHAT_SHORT_KEY: "short", AGENTIC_CHAT_MODEL: "no" },
      `# comment\nexport OTHER_TOKEN=${ENV_FILE_VALUE}\nEMPTY_SECRET=\n`,
    );

    expect(list).toContain(EXACT_ENV_VALUE);
    expect(list).toContain(ENV_FILE_VALUE);
    expect(list).not.toContain("short");
    expect(list).not.toContain("no");
  });

  it("creates a redactor from an explicit root", () => {
    const root = tempDir();
    writeFileSync(path.join(root, ".env"), `AGENTIC_CHAT_TEST_TOKEN=${ENV_FILE_VALUE}\n`);

    const redactor = createRedactor({ env: {}, root });

    expect(redactor.secrets).toContain(ENV_FILE_VALUE);
    expect(redactor.redact(`token=${ENV_FILE_VALUE}`)).toBe("token=[REDACTED_SECRET]");
  });

  it("redacts stdin and a file in place", () => {
    const stdin = spawnSync(process.execPath, [SCRIPT], {
      input: `key=${OPENROUTER_KEY}\n`,
      encoding: "utf8",
    });
    expect(stdin.status, stdin.stderr).toBe(0);
    expect(stdin.stdout).toContain("[REDACTED_OPENROUTER_KEY]");
    expect(stdin.stdout).not.toContain(OPENROUTER_KEY);

    const file = path.join(tempDir(), "run.log");
    writeFileSync(file, `key=${OPENCODE_KEY}\n`);
    const inPlace = spawnSync(process.execPath, [SCRIPT, "--file", file, "--in-place"], {
      encoding: "utf8",
    });
    expect(inPlace.status, inPlace.stderr).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("[REDACTED_OPENCODE_KEY]");
    expect(text).not.toContain(OPENCODE_KEY);
  });

  it("replaces an exact value before a pattern inside it", () => {
    const exact = `prefix-${OPENROUTER_KEY}-suffix`;
    const list = collectSecrets({ AGENTIC_CHAT_EXACT_TEST_KEY: exact }, "");

    const output = redactText(`token=${exact}`, list);

    expect(output).toBe("token=[REDACTED_SECRET]");
    expect(output).not.toContain(exact);
    expect(output).not.toContain(OPENROUTER_KEY);
    expect(output).not.toContain("prefix-");
  });

  it("redacts a verify step before it reaches stdout and the log file", () => {
    const { root, scriptsDir, binDir } = makeVerifyRoot();
    // Two chunks of one line, so a per-chunk replacement would miss the key.
    writeFakeVitest(
      binDir,
      [
        "#!/usr/bin/env node",
        `process.stdout.write(${JSON.stringify(`{"env":"${SINK_SECRET.slice(0, 12)}`)});`,
        `setTimeout(() => {`,
        `  process.stdout.write(${JSON.stringify(`${SINK_SECRET.slice(12)}"\nTests  2 passed (2)\n`)});`,
        `}, 25);`,
        "",
      ].join("\n"),
    );

    const result = runVerify(root, scriptsDir, ["change", "test/example.test.ts"], {
      AGENTIC_CHAT_SINK_TEST_KEY: SINK_SECRET,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[REDACTED_SECRET]");
    expect(result.stdout).toContain("2 passed");
    expect(result.stdout).not.toContain(SINK_SECRET);

    const log = unitTestLog(root);
    expect(log).toContain("[REDACTED_SECRET]");
    expect(log).not.toContain(SINK_SECRET);
  });

  it("keeps stdout and stderr line buffers separate", () => {
    const { root, scriptsDir, binDir } = makeVerifyRoot();
    const partial = SPLIT_SECRET.slice(0, 18);
    const rest = SPLIT_SECRET.slice(18);
    writeFakeVitest(
      binDir,
      [
        "#!/usr/bin/env node",
        `process.stdout.write(${JSON.stringify(partial)});`,
        `setTimeout(() => {`,
        `  process.stderr.write(${JSON.stringify("\n")});`,
        `  setTimeout(() => {`,
        `    process.stdout.write(${JSON.stringify(`${rest}\nTests  2 passed (2)\n`)});`,
        `  }, 40);`,
        `}, 40);`,
        "",
      ].join("\n"),
    );

    const result = runVerify(root, scriptsDir, ["change", "test/example.test.ts"], {
      AGENTIC_CHAT_SPLIT_TEST_KEY: SPLIT_SECRET,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[REDACTED_SECRET]");
    expect(result.stdout).not.toContain(SPLIT_SECRET);
    expect(result.stdout).not.toContain(partial);
    expect(result.stdout).not.toContain(rest.slice(0, 8));

    const log = unitTestLog(root);
    expect(log).toContain("[REDACTED_SECRET]");
    expect(log).not.toContain(partial);
    expect(log).not.toContain(SPLIT_SECRET);
  });

  it("redacts a key in a step's command in summary.json", () => {
    const { root, scriptsDir, binDir } = makeVerifyRoot();
    writeFakeVitest(
      binDir,
      [
        "#!/usr/bin/env node",
        `process.stdout.write(${JSON.stringify("Tests  2 passed (2)\n")});`,
        "",
      ].join("\n"),
    );

    const result = runVerify(root, scriptsDir, ["change", OPENROUTER_KEY]);

    expect(result.status, result.stderr).toBe(0);
    const stamp = readdirSync(path.join(root, "logs", "verify"))[0];
    const summary = readFileSync(path.join(root, "logs", "verify", stamp, "summary.json"), "utf8");
    expect(summary).toContain("[REDACTED_OPENROUTER_KEY]");
    expect(summary).not.toContain(OPENROUTER_KEY);
  });
});
