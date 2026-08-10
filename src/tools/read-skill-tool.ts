import { type AgentTool, type Skill, formatSkillInvocation } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const ReadSkillParameters = Type.Object({
  name: Type.String({
    description: "exact skill name from the available_skills listing",
  }),
});

/**
 * Create the `read_skill` tool: loads the full content of a named skill on demand.
 * This lets the agent consult skill instructions reactively rather than keeping all
 * skill bodies in the system prompt. Works for vault skills (reads the file) and
 * built-in skills (returns the inline content).
 */
export function createReadSkillTool(skills: Skill[]): AgentTool<typeof ReadSkillParameters, unknown> {
  return {
    name: "read_skill",
    label: "Read skill",
    description:
      "Load a skill's full instructions by its exact name from the available_skills listing.",
    parameters: ReadSkillParameters,
    execute: async (_id, params) => {
      const skill = skills.find((s) => s.name === params.name);
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ") || "(none)";
        throw new Error(`No skill named "${params.name}". Available: ${available}.`);
      }
      return {
        content: [{ type: "text", text: formatSkillInvocation(skill) }],
        details: undefined,
      };
    },
  };
}
