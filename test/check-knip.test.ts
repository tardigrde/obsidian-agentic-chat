import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(readFileSync(path.join(root, "knip.json"), "utf8")) as {
  entry: string[];
  rules: Record<string, string>;
};

describe("knip gate", () => {
  it("scans source, scripts, and tests, while leaving noisy export checks off", () => {
    expect(config.entry).toEqual(expect.arrayContaining(["src/main.ts", "scripts/**/*.{ts,mjs}"]));
    expect(config.entry).toEqual(expect.arrayContaining(["test/**/*.test.ts", "test/**/*.e2e.ts"]));
    expect(config.rules).toMatchObject({ exports: "off", types: "off", duplicates: "off" });
  });

  it(
    "reports no unused files, dependencies, binaries, or unresolved imports",
    () => {
      const result = spawnSync(process.execPath, [path.join(root, "node_modules/knip/bin/knip.js"), "--no-progress"], {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).not.toContain("Unused files");
      expect(output).not.toContain("Unused dependencies");
      expect(output).not.toContain("Unlisted");
      expect(output).not.toContain("Unresolved");
    },
    60_000,
  );
});
