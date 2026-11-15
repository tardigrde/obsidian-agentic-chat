import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Build the fake key from parts so this tracked file has no matching literal.
const LEAK_KEY = ["sk", "or", "v1", "feedfacecafebeef0123456789"].join("-");

const SCRIPT = fileURLToPath(new URL("../scripts/check-secrets.mjs", import.meta.url));
const HOOKS = fileURLToPath(new URL("../scripts/install-hooks.mjs", import.meta.url));

const tempDirs: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "check-secrets-"));
  tempDirs.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function run(script: string, root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` };
}

function leakyLog(root: string): string {
  const log = path.join(root, "logs", "run.log");
  mkdirSync(path.dirname(log), { recursive: true });
  writeFileSync(log, `WebDriver error: ${LEAK_KEY}\n`);
  return log;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("check-secrets", () => {
  it("fails with a path and a count, never the value", () => {
    const root = makeRepo();
    leakyLog(root);

    const result = run(SCRIPT, root);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^LEAK logs\/run\.log \(1\)$/m);
    expect(result.output).not.toContain(LEAK_KEY);
  });

  it("passes on a clean repo", () => {
    const root = makeRepo();
    writeFileSync(path.join(root, "README.md"), "nothing to see here\n");

    const result = run(SCRIPT, root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("LEAK");
  });

  it("redacts a log in place with --fix, and the next scan is clean", () => {
    const root = makeRepo();
    const log = leakyLog(root);

    const fixed = run(SCRIPT, root, "--fix");
    expect(fixed.status, fixed.stderr).toBe(0);
    expect(fixed.stdout).toMatch(/^REDACTED logs\/run\.log \(1\)$/m);
    expect(fixed.stdout).not.toContain(LEAK_KEY);

    const text = readFileSync(log, "utf8");
    expect(text).toContain("[REDACTED_OPENROUTER_KEY]");
    expect(text).not.toContain(LEAK_KEY);

    const next = run(SCRIPT, root);
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).not.toContain("LEAK");
  });

  it("never edits a tracked file, even with --fix", () => {
    const root = makeRepo();
    const tracked = path.join(root, "app.ts");
    writeFileSync(tracked, `const key = "${LEAK_KEY}";\n`);
    execFileSync("git", ["add", "app.ts"], { cwd: root });

    const result = run(SCRIPT, root, "--fix");

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^LEAK app\.ts \(1\)$/m);
    expect(readFileSync(tracked, "utf8")).toContain(LEAK_KEY);
  });

  it("scans a file over 20 MB instead of reporting clean", () => {
    const root = makeRepo();
    const log = path.join(root, "logs", "big.log");
    mkdirSync(path.dirname(log), { recursive: true });
    const payload = Buffer.alloc(21 * 1024 * 1024, 0x78);
    Buffer.from(`WebDriver error: ${LEAK_KEY}\n`).copy(payload);
    writeFileSync(log, payload);

    const result = run(SCRIPT, root);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^LEAK logs\/big\.log \(\d+\)$/m);
    expect(result.stdout).not.toContain("clean");
    expect(result.output).not.toContain(LEAK_KEY);
  });

  it("scans and fixes a symlinked log", () => {
    const root = makeRepo();
    const target = path.join(root, "target.log");
    writeFileSync(target, `WebDriver error: ${LEAK_KEY}\n`);
    const link = path.join(root, "logs", "linked.log");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link);

    const scan = run(SCRIPT, root);
    expect(scan.status).toBe(1);
    expect(scan.stdout).toMatch(/^LEAK logs\/linked\.log \(\d+\)$/m);
    expect(scan.output).not.toContain(LEAK_KEY);

    const fixed = run(SCRIPT, root, "--fix");
    expect(fixed.status, fixed.stderr).toBe(0);
    expect(fixed.stdout).toMatch(/^REDACTED logs\/linked\.log \(\d+\)$/m);
    const text = readFileSync(target, "utf8");
    expect(text).toContain("[REDACTED_OPENROUTER_KEY]");
    expect(text).not.toContain(LEAK_KEY);

    const next = run(SCRIPT, root);
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).not.toContain("LEAK");
  });

  it("skips .env and node_modules", () => {
    const root = makeRepo();
    writeFileSync(path.join(root, ".env"), `AGENTIC_CHAT_TEST_API_KEY=${LEAK_KEY}\n`);
    const dependency = path.join(root, "node_modules", "pkg", "index.js");
    mkdirSync(path.dirname(dependency), { recursive: true });
    writeFileSync(dependency, `const key = "${LEAK_KEY}";\n`);
    execFileSync("git", ["add", "-f", ".env", "node_modules/pkg/index.js"], { cwd: root });

    const result = run(SCRIPT, root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.output).not.toContain("LEAK");
    expect(result.output).not.toContain(LEAK_KEY);
  });

  it("installs a pre-push hook and refuses to overwrite it without --force", () => {
    const root = makeRepo();

    const first = run(HOOKS, root);
    expect(first.status, first.stderr).toBe(0);
    const hook = path.join(root, ".git", "hooks", "pre-push");
    const content = readFileSync(hook, "utf8");
    expect(content).toContain("npm run check:secrets -- --all-worktrees");
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    expect(first.stdout).toContain(hook);

    const second = run(HOOKS, root);
    expect(second.status).toBe(1);
    expect(second.output).toContain("--force");

    const forced = run(HOOKS, root, "--force");
    expect(forced.status, forced.stderr).toBe(0);
  });
});
