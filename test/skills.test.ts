import { describe, expect, it } from "vitest";
import type { Skill } from "@earendil-works/pi-agent-core";
import { buildSkillInvocation } from "../src/skills/skills";

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

  it("does not treat currency like $10, $1.50, $1,000 or a trailing $1. as placeholders", () => {
    const out = buildSkillInvocation(skill("Costs $10, $1.50, $1,000 — about $1."), "extra instructions");
    expect(out).toContain("Costs $10, $1.50, $1,000 — about $1.");
    expect(out).toContain("extra instructions");
  });
});
