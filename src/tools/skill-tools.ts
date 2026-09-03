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

const CreateSkillParameters = Type.Object({
  name: Type.String({
    description: "skill slug, e.g. release-notes",
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  }),
  description: Type.String({ description: "one line: what it does, when to use it" }),
  body: Type.String({ description: "skill markdown body" }),
  overwrite: Type.Optional(
    Type.Boolean({ description: "replace existing same-named package (only after user confirmed)" }),
  ),
});

/** Minimal scaffold surface so the agent tool reuses the New skill wizard writer without importing PluginService. */
export interface SkillScaffolder {
  packageExists(name: string): Promise<boolean>;
  scaffoldSkill(
    input: {
      name: string;
      description: string;
      body: string;
    },
    options?: { source?: string; allowOverwrite?: boolean },
  ): Promise<{ rootPath: string; name: string; updated: boolean; skills: number }>;
}

/**
 * Create `create_skill` harness tool: scaffolds a single-skill Agent Plugins
 * package through the same writer as the Resources tab New skill wizard
 * (spec-valid plugin.json + skills/<name>/SKILL.md, dot-folder safe).
 * The model must prefer this over hand-writing files under the plugins folder
 * with `write` — the generic file tools cannot see stale dot-folder trees.
 * Fail-closed on collisions: reports `alreadyExists` instead of replacing, so
 * the model must ask the user and retry with `overwrite: true` to replace.
 * Created packages are not undoable — the result says so.
 */
export function createCreateSkillTool(scaffolder: SkillScaffolder): AgentTool<typeof CreateSkillParameters, unknown> {
  return {
    name: "create_skill",
    label: "Create skill",
    description:
      "Scaffold a single-skill plugin package (plugin.json + skills/<name>/SKILL.md). " +
      "Prefer over hand-writing plugin files. Refuses replace unless overwrite is true (after user confirmed). " +
      "Persists across sessions; not undoable via /undo.",
    parameters: CreateSkillParameters,
    execute: async (_id, params) => {
      const name = params.name.trim().toLowerCase();
      if (!params.overwrite && (await scaffolder.packageExists(name))) {
        return {
          content: [
            {
              type: "text",
              text:
                `A plugin named "${name}" already exists. Nothing was written. ` +
                `Ask the user whether to replace it (retry with overwrite: true) or pick another name.`,
            },
          ],
          details: { name, alreadyExists: true },
        };
      }
      const result = await scaffolder.scaffoldSkill(
        {
          name: params.name,
          description: params.description,
          body: params.body,
        },
        { source: "Agent create_skill", allowOverwrite: params.overwrite ?? false },
      );
      const text = result.updated
        ? `Replaced skill "${result.name}" in ${result.rootPath}. The previous package is gone and cannot be undone with /undo.`
        : `Created skill "${result.name}" in ${result.rootPath}. It appears in the Resources tab; MCP servers are not involved. It persists across sessions and cannot be undone with /undo.`;
      return {
        content: [{ type: "text", text }],
        details: { ...result },
      };
    },
  };
}
