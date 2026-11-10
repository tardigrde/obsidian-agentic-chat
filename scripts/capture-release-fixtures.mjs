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
import { copyFileSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const tag = process.argv[2];
if (!tag || !/^\d+\.\d+\.\d+$/.test(tag)) {
  console.error("usage: npm run capture:release-fixtures -- <version tag, e.g. 0.51.10>");
  process.exit(2);
}
const root = process.cwd();
// The tag matched a strict x.y.z pattern above, so it cannot escape this folder.
const out = path.join(root, "test", "fixtures", "releases", tag); // NOSONAR:S8707 -- tag validated as x.y.z.
const work = mkdtempSync(path.join(tmpdir(), `release-fixture-${tag}-`));
const checkout = path.join(work, "src");
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "inherit" });
try {
  git("worktree", "add", "--detach", checkout, tag);
  symlinkSync(path.join(root, "node_modules"), path.join(checkout, "node_modules"));
  const spec = path.join(checkout, "test", "__release_fixture_capture.test.ts");
  copyFileSync(path.join(root, "scripts", "release-fixtures", "capture.spec.ts"), spec);
  // Capture into a temp folder and swap only after it validates, so a failed
  // run never deletes the committed fixture.
  // Stage next to the target: a rename from the OS temp dir can cross devices.
  const staged = `${out}.staging`;
  rmSync(staged, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", spec], {
    cwd: checkout,
    stdio: "inherit",
    env: { ...process.env, RELEASE_FIXTURE_OUT: staged },
  });
  const sessions = existsSync(path.join(staged, "sessions")) ? readdirSync(path.join(staged, "sessions")) : [];
  if (!existsSync(path.join(staged, "data.json")) || !sessions.some((file) => file.endsWith(".jsonl"))) {
    throw new Error("capture produced no data.json or no session JSONL; the committed fixture is unchanged");
  }
  const previous = `${out}.previous`;
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(out)) renameSync(out, previous);
  try {
    renameSync(staged, out);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, out);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
  process.stdout.write(`release fixtures: wrote ${path.relative(root, out)}\n`);
} finally {
  try {
    git("worktree", "remove", "--force", checkout);
  } catch {
    // Leave the temp checkout for inspection if removal fails.
  }
  rmSync(work, { recursive: true, force: true });
  rmSync(`${out}.staging`, { recursive: true, force: true });
}
