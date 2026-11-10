import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards the release decisions from #289. The default "angular" preset ignores
// `feat!:` headers and turns a BREAKING CHANGE footer into a 1.0.0 bump. While
// the plugin is on 0.x, breaking changes must bump minor, and both the analyzer
// and the notes must use the same preset that release.yml installs.

type PluginEntry = string | [string, Record<string, unknown>];

const releaserc = JSON.parse(readFileSync(".releaserc.json", "utf8")) as { plugins: PluginEntry[] };
const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as { version: string };
const releaseYml = readFileSync(".github/workflows/release.yml", "utf8");

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

  it("bumps minor, not major, for breaking changes while on 0.x", () => {
    if (!manifest.version.startsWith("0.")) return; // 1.0 was taken on purpose.
    const rules = pluginOptions("@semantic-release/commit-analyzer").releaseRules as
      | Array<{ breaking?: boolean; release?: string }>
      | undefined;
    expect(rules).toContainEqual({ breaking: true, release: "minor" });
  });

  it("installs the preset package in the release job", () => {
    expect(releaseYml).toMatch(/--package conventional-changelog-conventionalcommits@\d+\.\d+\.\d+/);
  });

  it("releases only a main push that passed the CI workflow", () => {
    expect(releaseYml).toMatch(/workflow_run:\s*\n\s*workflows: \[CI\]/);
    expect(releaseYml).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(releaseYml).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
    expect(releaseYml).not.toMatch(/^\s*push:/m);
  });
});
