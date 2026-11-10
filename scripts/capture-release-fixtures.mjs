#!/usr/bin/env node
/**
 * Capture upgrade fixtures from a released version (#290).
 *
 *   npm run capture:release-fixtures -- <tag>
 *
 * Checks out <tag> in a temporary worktree, links this checkout's
 * node_modules, and runs scripts/release-fixtures/capture.spec.ts with the
 * release's own vitest config. Output: test/fixtures/releases/<tag>/
 * (data.json, secrets.json, sessions/*.jsonl). Commit the result; the
 * upgrade tests in test/upgrade-fixtures.test.ts load every captured release.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const tag = process.argv[2];
if (!tag || !/^\d+\.\d+\.\d+$/.test(tag)) {
  console.error("usage: npm run capture:release-fixtures -- <version tag, e.g. 0.51.10>");
  process.exit(2);
}
const root = process.cwd();
const out = path.join(root, "test", "fixtures", "releases", tag);
const work = mkdtempSync(path.join(tmpdir(), `release-fixture-${tag}-`));
const checkout = path.join(work, "src");
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "inherit" });
try {
  git("worktree", "add", "--detach", checkout, tag);
  symlinkSync(path.join(root, "node_modules"), path.join(checkout, "node_modules"));
  const spec = path.join(checkout, "test", "__release_fixture_capture.test.ts");
  copyFileSync(path.join(root, "scripts", "release-fixtures", "capture.spec.ts"), spec);
  if (existsSync(out)) rmSync(out, { recursive: true });
  execFileSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", spec], {
    cwd: checkout,
    stdio: "inherit",
    env: { ...process.env, RELEASE_FIXTURE_OUT: out },
  });
  console.log(`release fixtures: wrote ${path.relative(root, out)}`);
} finally {
  try {
    git("worktree", "remove", "--force", checkout);
  } catch {
    // Leave the temp checkout for inspection if removal fails.
  }
  rmSync(work, { recursive: true, force: true });
}
