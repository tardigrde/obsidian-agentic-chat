import { describe, expect, it } from "vitest";
import { builtinSkills, DEEP_RESEARCH_SKILL, SELF_KNOWLEDGE_SKILL } from "../src/skills/builtin-skills";

describe("builtinSkills", () => {
  it("offers self-knowledge when web access is off", () => {
    const skills = builtinSkills(false);
    expect(skills.map((skill) => skill.name)).toEqual(["self-knowledge"]);
  });

  it("offers self-knowledge and deep-research when web access is on", () => {
    const skills = builtinSkills(true);
    expect(skills.map((skill) => skill.name)).toEqual(["self-knowledge", "deep-research"]);
  });

  it("describes a search → read → cite → save loop", () => {
    expect(DEEP_RESEARCH_SKILL.content).toMatch(/subagent/);
    expect(DEEP_RESEARCH_SKILL.content).toMatch(/researcher/);
    expect(DEEP_RESEARCH_SKILL.content).toMatch(/reviewer/);
    expect(DEEP_RESEARCH_SKILL.content).toMatch(/web_search/);
    expect(DEEP_RESEARCH_SKILL.content).toMatch(/fetch_url/);
    expect(DEEP_RESEARCH_SKILL.content).toMatch(/source artifact/i);
    expect(DEEP_RESEARCH_SKILL.content).toMatch(/## Sources/);
    expect(DEEP_RESEARCH_SKILL.filePath).toBe("(built-in)");
  });

  it("covers tools inventory, constraints, error patterns, doomloop guards, and URLs", () => {
    expect(SELF_KNOWLEDGE_SKILL.content).toMatch(/Tools inventory/);
    expect(SELF_KNOWLEDGE_SKILL.content).toMatch(/Edit semantics/);
    expect(SELF_KNOWLEDGE_SKILL.content).toMatch(/Approval modes/);
    expect(SELF_KNOWLEDGE_SKILL.content).toMatch(/Tool budget/);
    expect(SELF_KNOWLEDGE_SKILL.content).toMatch(/Doomloop guard/);
    expect(SELF_KNOWLEDGE_SKILL.content).toMatch(/Error pattern catalog/);
    expect(SELF_KNOWLEDGE_SKILL.content).toMatch(/subagent/);
    expect(SELF_KNOWLEDGE_SKILL.content).toMatch(/Do not spawn subagents after being told not to/i);
    expect(SELF_KNOWLEDGE_SKILL.content).toMatch(/https:\/\/github.com\/tardigrde\/obsidian-agentic-chat\/issues/);
    expect(SELF_KNOWLEDGE_SKILL.content).toMatch(/https:\/\/community.obsidian.md\/plugins\/agentic-chat/);
    expect(SELF_KNOWLEDGE_SKILL.filePath).toBe("(built-in)");
  });
});
