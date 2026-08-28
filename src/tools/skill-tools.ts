import { type AgentTool, type Skill } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { getLoadedSkillNames, isSkillLoaded, loadSkill, unloadSkill } from "../skills/skill-load-state";

const LoadSkillParameters = Type.Object({
  name: Type.String({ description: "skill name to load", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
});

const UnloadSkillParameters = Type.Object({
  name: Type.String({ description: "skill name to unload", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
});

function normalizeSkillName(input: string): string {
  return input.trim().normalize("NFKC").toLowerCase();
}

function requireSkill(skills: Skill[], rawName: string): Skill {
  const key = normalizeSkillName(rawName);
  const skill = skills.find((s) => s.name === key);
  if (!skill) {
    const available = skills.map((s) => s.name).join(", ") || "(none)";
    throw new Error(`No skill named "${rawName}". Available: ${available}.`);
  }
  return skill;
}

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
    description: "Load a skill's body into prompt for subsequent turns. Progressive disclosure.",
    parameters: LoadSkillParameters,
    execute: async (_id, params) => {
      const skill = requireSkill(skills, params.name);
      if (isSkillLoaded(skill.name)) {
        return {
          content: [{ type: "text", text: `Skill "${skill.name}" already loaded.` }],
          details: { name: skill.name, loaded: true, alreadyLoaded: true, loadedSkills: getLoadedSkillNames() },
        };
      }
      loadSkill(skill.name);
      const estTokens = Math.ceil(skill.content.length / 4);
      return {
        content: [
          {
            type: "text",
            text: `Loaded skill "${skill.name}" (~${estTokens} tok) — body now in system prompt for subsequent turns.`,
          },
        ],
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
      const skill = requireSkill(skills, params.name);
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
