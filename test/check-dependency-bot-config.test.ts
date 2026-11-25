import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEPENDABOT_CONFIG,
  RENOVATE_CONFIG,
  checkDependencyBotConfig,
} from "../scripts/check-dependency-bot-config.mjs";
import { staticSteps } from "../scripts/verify-lanes.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const paired = {
  packageRules: [
    { groupName: "vitest", matchPackageNames: ["vitest", "@vitest/**"] },
    { groupName: "earendil-works", matchPackageNames: ["@earendil-works/**"] },
  ],
};

function readRepoConfig() {
  const renovatePath = path.join(root, RENOVATE_CONFIG);
  return {
    renovate: existsSync(renovatePath) ? readFileSync(renovatePath, "utf8") : null,
    dependabot: existsSync(path.join(root, DEPENDABOT_CONFIG)),
  };
}

describe("dependency bot config", () => {
  it("keeps one bot and the two groups that prevent a split bump", () => {
    expect(checkDependencyBotConfig(readRepoConfig())).toEqual([]);
  });

  it("runs the bot config check in the static T0 steps", () => {
    expect(staticSteps().map((step) => step.label)).toContain("dependency bot config");
  });

  it("fails when Dependabot and Renovate are both configured", () => {
    expect(
      checkDependencyBotConfig({ renovate: JSON.stringify(paired), dependabot: true }).join("\n"),
    ).toMatch(/\.github\/dependabot\.yml exists/);
  });

  it("fails when renovate.json is missing or is not JSON", () => {
    expect(checkDependencyBotConfig({ renovate: null, dependabot: false })).toContain(
      "renovate.json is missing",
    );
    expect(checkDependencyBotConfig({ renovate: "{", dependabot: false }).join("\n")).toMatch(
      /renovate\.json is not valid JSON/,
    );
  });

  it("fails when a group loses a package, so the pair can split", () => {
    const errors = checkDependencyBotConfig({
      renovate: JSON.stringify({
        packageRules: [
          { groupName: "vitest", matchPackageNames: ["vitest"] },
          { groupName: "earendil-works", matchPackageNames: ["@earendil-works/pi-ai"] },
        ],
      }),
      dependabot: false,
    });
    expect(errors).toContain('renovate.json: group "vitest" must match "@vitest/**"');
    expect(errors).toContain('renovate.json: group "earendil-works" must match "@earendil-works/**"');
  });
});
