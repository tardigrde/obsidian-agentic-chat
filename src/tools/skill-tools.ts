import { type AgentTool, type Skill, formatSkillInvocation } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { getLoadedSkillNames, loadSkill, unloadSkill } from "../skills/skill-load-state";

const LoadSkillParameters = Type.Object({
  name: Type.String({ description: "skill name to load" }),
});

const UnloadSkillParameters = Type.Object({
  name: Type.String({ description: "skill name to unload" }),
});

/**
 * Create `load_skill` harness tool: persistently injects the full skill body
 * into the system prompt for subsequent turns (progressive disclosure). The
 * body is also returned immediately so the model can use it this turn.
 * Reuses F10's skill registry; no path confinement needed (skill root already
 * validated). Idempotent.
 */
export function createLoadSkillTool(skills: Skill[]): AgentTool<typeof LoadSkillParameters, unknown> {
  return {
    name: "load_skill",
    label: "Load skill",
    description: "Load a skill's full body into prompt for this session. Progressive disclosure.",
    parameters: LoadSkillParameters,
    execute: async (_id, params) => {
      const skill = skills.find((s) => s.name === params.name);
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ") || "(none)";
        throw new Error(`No skill named "${params.name}". Available: ${available}.`);
      }
      loadSkill(skill.name);
      return {
        content: [{ type: "text", text: formatSkillInvocation(skill) }],
        details: { name: skill.name, loaded: true, loadedSkills: getLoadedSkillNames() },
      };
    },
  };
}

/**
 * Create `unload_skill` harness tool: removes a previously loaded skill from
 * the prompt overlay, freeing context. No-op if not loaded.
 */
export function createUnloadSkillTool(skills: Skill[]): AgentTool<typeof UnloadSkillParameters, unknown> {
  return {
    name: "unload_skill",
    label: "Unload skill",
    description: "Unload a skill to free prompt context. No-op if not loaded.",
    parameters: UnloadSkillParameters,
    execute: async (_id, params) => {
      const skill = skills.find((s) => s.name === params.name);
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ") || "(none)";
        throw new Error(`No skill named "${params.name}". Available: ${available}.`);
      }
      const wasLoaded = unloadSkill(skill.name);
      return {
        content: [{ type: "text", text: wasLoaded ? `Unloaded skill "${skill.name}".` : `Skill "${skill.name}" was not loaded.` }],
        details: { name: skill.name, unloaded: wasLoaded, loadedSkills: getLoadedSkillNames() },
      };
    },
  };
}

export function createSkillLoadTools(skills: Skill[]): AgentTool[] {
  return [createLoadSkillTool(skills), createUnloadSkillTool(skills)];
}
