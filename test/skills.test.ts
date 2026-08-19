import { describe, expect, it } from "vitest";
import type { Skill } from "@earendil-works/pi-agent-core";
import { buildSkillInvocation } from "../src/skills/skills";
import { parseSkillMarkdown, skillNameProblem } from "../src/skills/skill-format";

describe("parseSkillMarkdown", () => {
  it("parses name/description and keeps the body as content", () => {
    const parsed = parseSkillMarkdown("---\nname: summarize\ndescription: Summarize things\n---\nBody.", "SKILL.md");
    expect(parsed.skill).toMatchObject({ name: "summarize", description: "Summarize things", content: "Body." });
    expect(parsed.problems).toEqual([]);
  });

  it("accepts Unicode lowercase skill names per the spec", () => {
    const parsed = parseSkillMarkdown("---\nname: 分析\ndescription: 分析笔记\n---\n分析。", "SKILL.md");
    expect(parsed.skill?.name).toBe("分析");
    expect(parsed.problems).toEqual([]);
  });

  it("NFKC-normalizes the skill name", () => {
    const parsed = parseSkillMarkdown("---\nname: ｓｕｍ\ndescription: ok\n---\nBody.", "SKILL.md");
    expect(parsed.skill?.name).toBe("sum");
  });

  it("rejects uppercase names, leading/trailing/double hyphens, and disallowed characters", () => {
    expect(skillNameProblem("Analysis")).toMatch(/lowercase/);
    expect(skillNameProblem("-analysis")).toMatch(/hyphen/);
    expect(skillNameProblem("analysis-")).toMatch(/hyphen/);
    expect(skillNameProblem("a--b")).toMatch(/hyphen/);
    expect(skillNameProblem("a b")).toMatch(/letters, numbers/);
  });

  it("counts length limits by code points, not UTF-16 units", () => {
    expect(skillNameProblem("𝟙".repeat(64))).toBeNull();
    expect(skillNameProblem("𝟙".repeat(65))).toMatch(/1-64/);
    const doc = `---\nname: ok\ndescription: ${"😀".repeat(1024)}\n---\nBody.`;
    expect(parseSkillMarkdown(doc, "SKILL.md").problems).toEqual([]);
    const tooLong = `---\nname: ok\ndescription: ${"😀".repeat(1025)}\n---\nBody.`;
    expect(parseSkillMarkdown(tooLong, "SKILL.md").problems[0]).toMatch(/1024/);
  });

  it("rejects missing name or description", () => {
    expect(parseSkillMarkdown("---\ndescription: only desc\n---\nBody.", "SKILL.md").problems[0]).toMatch(/"name"/);
    expect(parseSkillMarkdown("---\nname: ok\n---\nBody.", "SKILL.md").problems[0]).toMatch(/"description"/);
  });

  it("reports invalid YAML frontmatter instead of a misleading missing-name error", () => {
    const parsed = parseSkillMarkdown("---\nname: tab\tbroken\n---\nBody.", "SKILL.md");
    expect(parsed.skill).toBeNull();
    expect(parsed.problems[0]).toMatch(/not valid YAML/);
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

  it("does not treat currency like $10, $1.50, $1,000 or a trailing $1. as placeholders", () => {
    const out = buildSkillInvocation(skill("Costs $10, $1.50, $1,000 — about $1."), "extra instructions");
    expect(out).toContain("Costs $10, $1.50, $1,000 — about $1.");
    expect(out).toContain("extra instructions");
  });
});
