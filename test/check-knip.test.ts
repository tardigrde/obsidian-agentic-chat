import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(readFileSync(path.join(root, "knip.json"), "utf8")) as {
  entry: string[];
  project: string[];
  rules: Record<string, string>;
};

// The `knip` static step runs the real binary; this only pins the config scope.
describe("knip gate", () => {
  it("scans source, scripts, and tests, while leaving noisy export checks off", () => {
    expect(config.entry).toEqual(expect.arrayContaining(["src/main.ts", "scripts/**/*.{ts,mjs}"]));
    expect(config.entry).toEqual(expect.arrayContaining(["test/**/*.test.ts", "test/**/*.e2e.ts"]));
    expect(config.entry).toContain("src/types/obsidian-history-handler.ts");
    expect(config.entry).not.toContain("src/types/**/*.ts");
    expect(config.project).toContain("!src/vendor/**");
    expect(config.rules).toMatchObject({ exports: "off", types: "off", duplicates: "off" });
  });

});
