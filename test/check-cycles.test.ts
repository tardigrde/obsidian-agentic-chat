import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  cycleText,
  findCycles,
  staleAllowlist,
  unexpectedCycles,
  SOURCE_DIR,
} from "../scripts/check-cycles.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "cycle-gate-"));
  temporaryDirs.push(root);
  mkdirSync(path.join(root, SOURCE_DIR), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(root, SOURCE_DIR, name), text);
  }
  return root;
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cycle gate", () => {
  it("has an empty allowlist and formats a cycle as one path", () => {
    expect(ALLOWLIST).toEqual([]);
    expect(cycleText(["a.ts", "b.ts"])).toBe("a.ts > b.ts");
  });

  it("separates a new cycle from an allowed one, and names a stale allowlist entry", () => {
    const cycles = [
      ["a.ts", "b.ts"],
      ["c.ts", "d.ts"],
    ];
    expect(unexpectedCycles(cycles, [["a.ts", "b.ts"]])).toEqual([["c.ts", "d.ts"]]);
    expect(staleAllowlist(cycles, [["a.ts", "b.ts"], ["gone.ts", "gone.ts"]])).toEqual([
      ["gone.ts", "gone.ts"],
    ]);
  });

  it(
    "detects a two-file import cycle in a fixture",
    async () => {
      const root = fixture({
        "a.ts": 'import { b } from "./b";\nexport const a = () => b;\n',
        "b.ts": 'import { a } from "./a";\nexport const b = () => a;\n',
      });
      const cycles = await findCycles(root);
      expect(cycles.map(cycleText)).toEqual(["a.ts > b.ts"]);
    },
    30_000,
  );

  it(
    "passes the real source tree with no cycles and no allowlist",
    async () => {
      expect(await findCycles(repoRoot)).toEqual([]);
    },
    30_000,
  );
});
