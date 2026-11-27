import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { toolResult } from "./result";

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
 * package through the same writer as the settings New skill flow
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
        return toolResult(
          `A plugin named "${name}" already exists. Nothing was written. ` +
            `Ask the user whether to replace it (retry with overwrite: true) or pick another name.`,
          { name, alreadyExists: true },
        );
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
        : `Created skill "${result.name}" in ${result.rootPath}. It appears in Settings > Advanced > Agent plugins; MCP servers are not involved. It persists across sessions and cannot be undone with /undo.`;
      return toolResult(text, { ...result });
    },
  };
}
