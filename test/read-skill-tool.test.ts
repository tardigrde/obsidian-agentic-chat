import { describe, expect, it } from "vitest";
import { createReadSkillTool } from "../src/tools/read-skill-tool";
import { SELF_KNOWLEDGE_SKILL, DEEP_RESEARCH_SKILL } from "../src/skills/builtin-skills";

describe("createReadSkillTool", () => {
  const skills = [SELF_KNOWLEDGE_SKILL, DEEP_RESEARCH_SKILL];
  const tool = createReadSkillTool(skills);

  it("returns the full skill content for a matching name", async () => {
    const result = await tool.execute("call-1", { name: "self-knowledge" }, undefined, undefined);
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("Self-knowledge");
    expect(text).toContain("Tools inventory");
    expect(text).toContain("Doomloop guard");
  });

  it("returns the full skill content for deep-research", async () => {
    const result = await tool.execute("call-2", { name: "deep-research" }, undefined, undefined);
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("Deep research");
    expect(text).toContain("subagent");
  });

  it("throws for an unknown skill name", async () => {
    await expect(tool.execute("call-3", { name: "nonexistent" }, undefined, undefined)).rejects.toThrow(
      "No skill named",
    );
  });
});
