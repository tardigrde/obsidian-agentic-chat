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

  it("fails a skill that names a removed delegate subcommand or chaos mode (#393 T26)", () => {
    const scripts = { delegate: "bash scripts/delegate.sh", verify: "node scripts/verify.mjs" };
    const skill = [
      "npm run delegate -- ship wt spec.md \"title\" \"focus\"",
      "npm run delegate -- review 7 wt \"focus\"",
      "npm run verify -- explore --mode focused --target settings",
      "npm run verify -- explore --mode smoke",
    ].join("\n");
    const errors = checkDoc(".agents/skills/fixture/SKILL.md", skill, scripts);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain(".agents/skills/fixture/SKILL.md:1 names the removed `npm run delegate -- ship`");
    expect(errors[1]).toContain(":3 names the removed");
    expect(errors[1]).toContain("--mode smoke");
  });

  it("fails a missing script and an unknown lane, and accepts live ones", () => {
    const text = [
      "npm run delegate -- review 12 wt focus",
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
