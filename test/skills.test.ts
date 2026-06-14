import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { Skill } from "@earendil-works/pi-agent-core";
import { buildSkillInvocation, loadVaultSkills } from "../src/skills/skills";
import { FakeApp } from "./helpers/fake-vault";

async function seed(): Promise<App> {
  const app = new FakeApp();
  await app.vault.createFolder("Skills");
  await app.vault.create(
    "Skills/summarize.md",
    "---\nname: Summarize\ndescription: Summarize the active note\n---\nWrite a 3-bullet summary.",
  );
  return app as unknown as App;
}

describe("loadVaultSkills", () => {
  it("parses frontmatter name/description and keeps the body as content", async () => {
    const skills = await loadVaultSkills(await seed(), "Skills");
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "Summarize",
      description: "Summarize the active note",
      filePath: "Skills/summarize.md",
    });
    expect(skills[0].content).toContain("3-bullet summary");
  });

  it("returns nothing when no folder is configured", async () => {
    expect(await loadVaultSkills(await seed(), "")).toEqual([]);
  });
});

describe("buildSkillInvocation", () => {
  const skill = (content: string): Skill => ({
    name: "Demo",
    description: "demo",
    content,
    filePath: "Skills/demo.md",
  });

  it("invokes a plain skill with no arguments", () => {
    const out = buildSkillInvocation(skill("Do the thing."));
    expect(out).toContain('<skill name="Demo"');
    expect(out).toContain("Do the thing.");
  });

  it("substitutes $ARGUMENTS/$1 placeholders from the arg string", () => {
    const out = buildSkillInvocation(skill("Summarize $1 and tag with $ARGUMENTS."), "Daily.md");
    expect(out).toContain("Summarize Daily.md and tag with Daily.md.");
  });

  it("respects shell-style quoting when parsing args", () => {
    const out = buildSkillInvocation(skill("Title: $1 / Body: $2"), '"My Note" body');
    expect(out).toContain("Title: My Note / Body: body");
  });

  it("appends args as freeform instructions when the body has no placeholders", () => {
    const out = buildSkillInvocation(skill("Base skill body."), "also be terse");
    expect(out).toContain("Base skill body.");
    expect(out).toContain("also be terse");
  });

  it("does not treat currency like $10 or $1.50 as placeholders", () => {
    const out = buildSkillInvocation(skill("The price is $10 and $1.50."), "extra instructions");
    expect(out).toContain("The price is $10 and $1.50.");
    expect(out).toContain("extra instructions");
  });
});
