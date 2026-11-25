import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEPENDABOT_CONFIGS,
  RENOVATE_CONFIG,
  checkDependencyBotConfig,
} from "../scripts/check-dependency-bot-config.mjs";
import { staticSteps } from "../scripts/verify-lanes.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const paired = {
  separateMajorMinor: false,
  packageRules: [
    { groupName: "vitest", matchPackageNames: ["vitest", "@vitest/**"] },
    { groupName: "earendil-works", matchPackageNames: ["@earendil-works/**"] },
  ],
};

function readRepoConfig() {
  const renovatePath = path.join(root, RENOVATE_CONFIG);
  return {
    renovate: existsSync(renovatePath) ? readFileSync(renovatePath, "utf8") : null,
    dependabotPaths: DEPENDABOT_CONFIGS.filter((config) => existsSync(path.join(root, config))),
  };
}

describe("dependency bot config", () => {
  it("keeps one bot and the two groups that prevent a split bump", () => {
    expect(checkDependencyBotConfig(readRepoConfig())).toEqual([]);
  });

  it("runs the bot config check in the static T0 steps", () => {
    expect(staticSteps().map((step) => step.label)).toContain("dependency bot config");
  });

  it("fails when either Dependabot filename is present", () => {
    for (const config of DEPENDABOT_CONFIGS) {
      expect(
        checkDependencyBotConfig({ renovate: JSON.stringify(paired), dependabotPaths: [config] }).join("\n"),
      ).toContain(`${config} exists`);
    }
  });

  it("fails when renovate.json is missing or is not JSON", () => {
    expect(checkDependencyBotConfig({ renovate: null }).join("\n")).toMatch(/renovate\.json is missing/);
    expect(checkDependencyBotConfig({ renovate: "{" }).join("\n")).toMatch(/renovate\.json is not valid JSON/);
  });

  it("fails when a group loses a package, so the pair can split", () => {
    const errors = checkDependencyBotConfig({
      renovate: JSON.stringify({
        separateMajorMinor: false,
        packageRules: [
          { groupName: "vitest", matchPackageNames: ["vitest"] },
          { groupName: "earendil-works", matchPackageNames: ["@earendil-works/pi-ai"] },
        ],
      }),
    });
    expect(errors).toContain('renovate.json: group "vitest" must match "@vitest/**"');
    expect(errors).toContain('renovate.json: group "earendil-works" must match "@earendil-works/**"');
  });

  it("fails when a required group excludes a package", () => {
    const errors = checkDependencyBotConfig({
      renovate: JSON.stringify({
        separateMajorMinor: false,
        packageRules: [
          {
            groupName: "vitest",
            matchPackageNames: ["vitest", "@vitest/**", "!@vitest/coverage-v8"],
          },
          { groupName: "earendil-works", matchPackageNames: ["@earendil-works/**"], excludePackageNames: ["@earendil-works/pi-ai"] },
        ],
      }),
    });
    expect(errors.join("\n")).toMatch(/group "vitest" must not exclude: !@vitest\/coverage-v8/);
    expect(errors.join("\n")).toMatch(/group "earendil-works" must not use excludePackageNames/);
  });

  it("fails when a major bump would split from its peers", () => {
    const errors = checkDependencyBotConfig({
      renovate: JSON.stringify({
        packageRules: [
          { groupName: "vitest", matchPackageNames: ["vitest", "@vitest/**"] },
          { groupName: "earendil-works", matchPackageNames: ["@earendil-works/**"], separateMajorMinor: false },
        ],
      }),
    });
    expect(errors.join("\n")).toMatch(/group "vitest" needs "separateMajorMinor": false/);
    expect(errors.join("\n")).not.toMatch(/group "earendil-works" needs/);
  });
});
