import { describe, expect, it } from "vitest";
import { builtinSkills, DEEP_RESEARCH_SKILL, INSTALL_PLUGIN_SKILL, SELF_KNOWLEDGE_SKILL } from "../src/skills/builtin-skills";

describe("builtinSkills", () => {
  it("offers self-knowledge and install-plugin when web access is off", () => {
    const skills = builtinSkills(false);
    expect(skills.map((skill) => skill.name)).toEqual(["self-knowledge", "install-plugin"]);
  });

  it("adds deep-research when web access is on", () => {
    const skills = builtinSkills(true);
    expect(skills.map((skill) => skill.name)).toEqual(["self-knowledge", "deep-research", "install-plugin"]);
  });

  it("ships every built-in skill as a built-in file, not a vault path", () => {
    // Skill wording is checked by the eval canary, not pinned here (#393 T17).
    for (const skill of [...builtinSkills(true), DEEP_RESEARCH_SKILL, SELF_KNOWLEDGE_SKILL]) {
      expect(skill.filePath).toBe("(built-in)");
      expect(skill.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("points at Settings > Advanced > Agent plugins, not the retired Resources and MCP tabs", () => {
    expect(INSTALL_PLUGIN_SKILL.content).toContain("Settings > Advanced > Agent plugins");
    expect(INSTALL_PLUGIN_SKILL.content).toContain("MCP tools section of Advanced");
    expect(INSTALL_PLUGIN_SKILL.content).not.toMatch(/Resources tab|MCP tab/);
    for (const skill of [...builtinSkills(true), DEEP_RESEARCH_SKILL, SELF_KNOWLEDGE_SKILL]) {
      expect(skill.content).not.toMatch(/Resources tab|MCP tab/);
    }
  });
});
