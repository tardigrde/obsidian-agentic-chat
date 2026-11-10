import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards the release decisions from #289. The default "angular" preset ignores
// `feat!:` headers and turns a BREAKING CHANGE footer into a 1.0.0 bump. While
// the plugin is on 0.x, breaking changes must bump minor, and both the analyzer
// and the notes must use the same preset that release.yml installs.

type PluginEntry = string | [string, Record<string, unknown>];

const releaserc = JSON.parse(readFileSync(".releaserc.json", "utf8")) as { plugins: PluginEntry[] };
const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as { version: string };
/** Workflow text without `#` comments, so a condition in a comment cannot satisfy a check. */
function workflowCode(file: string): string {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
}

const releaseYml = workflowCode(".github/workflows/release.yml");
const ciYml = workflowCode(".github/workflows/ci.yml");

function pluginOptions(name: string): Record<string, unknown> {
  const entry = releaserc.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);
  expect(entry, `${name} is configured`).toBeDefined();
  return Array.isArray(entry) ? entry[1] : {};
}

describe("release config", () => {
  it("parses `!` breaking headers with the conventionalcommits preset", () => {
    expect(pluginOptions("@semantic-release/commit-analyzer").preset).toBe("conventionalcommits");
    expect(pluginOptions("@semantic-release/release-notes-generator").preset).toBe("conventionalcommits");
  });

  it("bumps minor for breaking changes on 0.x, and drops that rule from 1.0", () => {
    const rules = (pluginOptions("@semantic-release/commit-analyzer").releaseRules ?? []) as Array<{
      breaking?: boolean;
      release?: string;
    }>;
    const breakingAsMinor = { breaking: true, release: "minor" };
    if (manifest.version.startsWith("0.")) expect(rules).toContainEqual(breakingAsMinor);
    // After 1.0, a breaking change must bump major again: remove the 0.x rule.
    else expect(rules).not.toContainEqual(breakingAsMinor);
  });

  it("installs the preset package in the release job", () => {
    expect(releaseYml).toMatch(/--package conventional-changelog-conventionalcommits@\d+\.\d+\.\d+/);
  });

  it("releases only a main push that passed the CI workflow", () => {
    expect(releaseYml).toMatch(/workflow_run:\s*\n\s*workflows: \[CI\]/);
    // Renaming the CI workflow would silently stop every release.
    expect(ciYml).toMatch(/^name: CI$/m);
    expect(releaseYml).toContain("github.event.workflow_run.conclusion == 'success'");
    // Fork protection: only same-repo push runs on main reach the job secrets.
    expect(releaseYml).toContain("github.event.workflow_run.event == 'push'");
    expect(releaseYml).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(releaseYml).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    expect(releaseYml).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
    expect(releaseYml).not.toMatch(/^\s*push:/m);
  });
});
