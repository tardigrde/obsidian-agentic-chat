import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkDoc, listDocs } from "../scripts/check-doc-commands.mjs";

const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;

describe("doc commands", () => {
  it("fails a doc that names a retired lane and names the replacement", () => {
    const errors = checkDoc("docs/fixture.md", "Run `npm run verify -- ci` before a PR.\n", scripts);
    expect(errors).toEqual([
      "docs/fixture.md:1 names the retired lane `verify -- ci`; use `verify -- check --no-app --coverage`",
    ]);
  });

  it("fails a missing script and an unknown lane, and accepts live ones", () => {
    const text = [
      "npm run delegate -- ship 12",
      "npm run verify:fast",
      "npm run verify -- bogus",
      "npm run verify -- check",
      "npm run verify -- app settings-ui",
      "npm run verify -- --list",
      "npm run verify -- <lane>",
    ].join("\n");
    const errors = checkDoc("x.md", text, scripts);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("x.md:2 names `npm run verify:fast`");
    expect(errors[1]).toContain("x.md:3 names an unknown lane `verify -- bogus`");
  });

  it("every doc, skill, and template in the repo names live commands only", () => {
    const docs = listDocs();
    expect(docs).toContain("AGENTS.md");
    expect(docs.some((file) => file.startsWith(".agents/skills/"))).toBe(true);
    const errors = docs.flatMap((file) => checkDoc(file, readFileSync(file, "utf8"), scripts));
    expect(errors).toEqual([]);
  });
});
