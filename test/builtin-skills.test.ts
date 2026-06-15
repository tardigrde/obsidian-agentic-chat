import { describe, expect, it } from "vitest";
import { builtinSkills, DEEP_RESEARCH_SKILL } from "../src/skills/builtin-skills";

describe("builtinSkills", () => {
  it("offers nothing when web access is off", () => {
    expect(builtinSkills(false)).toEqual([]);
  });

  it("offers deep-research only when web access is on", () => {
    const skills = builtinSkills(true);
    expect(skills.map((skill) => skill.name)).toEqual(["deep-research"]);
  });

  it("describes a search → read → cite → save loop", () => {
    expect(DEEP_RESEARCH_SKILL.content).toMatch(/web_search/);
    expect(DEEP_RESEARCH_SKILL.content).toMatch(/fetch_url/);
    expect(DEEP_RESEARCH_SKILL.content).toMatch(/## Sources/);
    expect(DEEP_RESEARCH_SKILL.filePath).toBe("(built-in)");
  });
});
