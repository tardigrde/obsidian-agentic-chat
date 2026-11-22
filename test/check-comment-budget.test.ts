import { describe, expect, it } from "vitest";
import {
  baselineFrom,
  compareBudget,
  isFunctionalComment,
  scanComments,
} from "../scripts/lib/comments.mjs";

const file = (text: string) => scanComments(text, "src/example.ts");

describe("comment budget", () => {
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

  it("keeps functional directives out of the ratchet", () => {
    for (const raw of [
      "/// <reference types=\"node\" />",
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

  it("warns only above the per-file frozen count", () => {
    const comments = new Map([
      ["src/over.ts", file("// one\nconst a = 1;\n// two\nconst b = 2;")],
      ["src/equal.ts", file("// one\nconst a = 1;")],
      ["src/under.ts", file("// one\nconst a = 1;")],
      ["src/new.ts", file("// fresh\nconst a = 1;")],
    ]);
    const baseline = {
      version: 1,
      total: 4,
      files: { "src/over.ts": 1, "src/equal.ts": 1, "src/under.ts": 3 },
    };
    const result = compareBudget(comments, baseline);
    expect(result.additions.map((entry) => entry.file)).toEqual(["src/over.ts", "src/new.ts"]);
    expect(result.additions[0]).toMatchObject({ baseline: 1, current: 2 });
    expect(result.additions[0].newComments.map((comment) => comment.raw)).toEqual(["// two"]);
    expect(result.currentTotal).toBe(5);
    expect(result.baselineTotal).toBe(5);
  });

  it("rebuilds a baseline that omits clean files and totals what remains", () => {
    const comments = new Map([
      ["src/b.ts", file("// one\n// two\nconst b = 1;")],
      ["src/a.ts", file("// one\nconst a = 1;")],
      ["src/clean.ts", file("const clean = true;")],
    ]);
    const baseline = baselineFrom(comments);
    expect(Object.keys(baseline.files)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(baseline.total).toBe(3);
    expect(baseline.files["src/clean.ts"]).toBeUndefined();
  });
});
