import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  blankComments,
  compareToBase,
  compareWithBase,
  isFunctionalComment,
  scanComments,
} from "../scripts/lib/comments.mjs";

const file = (text: string) => scanComments(text, "src/example.ts");

describe("comment scanner", () => {
  it("finds line and block comments but not markers inside strings, templates, or regexes", () => {
    const text = [
      'const url = "https://example.com//not-a-comment";',
      "const template = `// not a comment ${1 + 1}`;",
      "const pattern = /\\/\\/ not a comment/;",
      "// real line",
      "/* real block */",
      "const x = 1; // trailing line",
    ].join("\n");
    expect(file(text).map((comment) => comment.raw)).toEqual([
      "// real line",
      "/* real block */",
      "// trailing line",
    ]);
    expect(file(text).map((comment) => comment.line)).toEqual([4, 5, 6]);
  });

  it("keeps functional directives out of the count", () => {
    for (const raw of [
      '/// <reference types="node" />',
      "// @ts-expect-error deliberate",
      "// eslint-disable-next-line no-console",
      "const x = 1; // NOSONAR",
      "/* istanbul ignore next */",
      "// Stryker disable next-line all",
      "// Adapted from pi-obsidian (Simon Liang), MIT License.",
    ]) {
      expect(isFunctionalComment(raw)).toBe(true);
    }
    expect(isFunctionalComment("// explain the ordering")).toBe(false);
  });

  it("blanks comments but keeps code, strings, and line numbers", () => {
    const text = ['const a = "Buffer"; // Buffer note', "/* Buffer", "   block */", "const b = Buffer.from(a);"].join("\n");
    const blanked = blankComments(text, "src/example.ts");
    expect(blanked.split("\n")).toHaveLength(4);
    expect(blanked).toHaveLength(text.length);
    expect(blanked).toContain('"Buffer"');
    expect(blanked).toContain("Buffer.from");
    expect(blanked.match(/\bBuffer\b/g)).toHaveLength(2);
  });
});

describe("comparison with the base branch", () => {
  it("warns only on a net increase in a file", () => {
    const current = new Map([
      ["src/over.ts", file("// one\nconst a = 1;\n// two\nconst b = 2;")],
      ["src/equal.ts", file("// one\nconst a = 1;")],
      ["src/under.ts", file("// one\nconst a = 1;")],
      ["src/new.ts", file("// fresh\nconst a = 1;")],
    ]);
    const base = new Map([
      ["src/over.ts", file("// one\nconst a = 1;")],
      ["src/equal.ts", file("// one\nconst a = 1;")],
      ["src/under.ts", file("// one\n// two\n// three\nconst a = 1;")],
    ]);
    const result = compareToBase(current, base);
    expect(result.additions.map((entry) => entry.file)).toEqual(["src/over.ts", "src/new.ts"]);
    expect(result.additions[0]).toMatchObject({ base: 1, current: 2, added: 1 });
    expect(result.additions[0].newComments.map((comment) => comment.raw)).toEqual(["// two"]);
    expect(result.currentTotal).toBe(5);
    expect(result.baseTotal).toBe(5);
  });

  it("lets a comment be reworded without a warning", () => {
    const current = new Map([["src/a.ts", file("// better words\nconst a = 1;")]]);
    const base = new Map([["src/a.ts", file("// old words\nconst a = 1;")]]);
    expect(compareToBase(current, base).additions).toEqual([]);
  });

  it("names the comment that is new, not the one that was already there", () => {
    const current = new Map([["src/a.ts", file("// keep\nconst a = 1;\n// added\nconst b = 2;\n// keep\n")]]);
    const base = new Map([["src/a.ts", file("// keep\nconst a = 1;\n// keep\n")]]);
    const [addition] = compareToBase(current, base).additions;
    expect(addition.newComments.map((comment) => comment.raw)).toEqual(["// added"]);
    expect(addition.newComments[0].line).toBe(3);
  });
});

describe("compareWithBase in a git repository", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "ignore" });

  function repo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comment-budget-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "// one\nexport const a = 1;\n");
    fs.writeFileSync(path.join(dir, "src", "b.ts"), "export const b = 1;\n");
    run(dir, "init", "-q", "-b", "main");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "base");
    return dir;
  }

  it("is empty on a clean tree and counts an added comment on a branch", () => {
    const dir = repo();
    expect(compareWithBase(["main"], dir)?.additions).toEqual([]);
    run(dir, "checkout", "-q", "-b", "topic");
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "// one\n// two\nexport const a = 1;\n");
    const result = compareWithBase(["main"], dir);
    expect(result?.additions.map((entry) => [entry.file, entry.added])).toEqual([["src/a.ts", 1]]);
  });

  it("counts every comment of an untracked file and skips a file that only lost comments", () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "src", "new.ts"), "// first\n// second\nexport const n = 1;\n");
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
    const result = compareWithBase(["main"], dir);
    expect(result?.additions.map((entry) => [entry.file, entry.added])).toEqual([["src/new.ts", 2]]);
  });

  it("compares a renamed file with its old path, not as all-new comments", () => {
    const dir = repo();
    run(dir, "checkout", "-q", "-b", "topic");
    run(dir, "mv", "src/a.ts", "src/renamed.ts");
    const renamed = compareWithBase(["main"], dir);
    expect(renamed?.additions).toEqual([]);
    fs.appendFileSync(path.join(dir, "src", "renamed.ts"), "// added after the rename\n");
    const grown = compareWithBase(["main"], dir);
    expect(grown?.additions.map((entry) => [entry.file, entry.added])).toEqual([["src/renamed.ts", 1]]);
  });

  it("returns null when no candidate ref exists", () => {
    expect(compareWithBase(["origin/nope", undefined], repo())).toBeNull();
  });
});
