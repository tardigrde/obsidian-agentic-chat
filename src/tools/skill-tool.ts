import type { AgentTool } from "@earendil-works/pi-agent-core";
import { formatSkillInvocation, type Skill } from "../skills/skill-prompt";
import { TFolder, type App } from "obsidian";
import { Type } from "typebox";
import { resolveSkillResourcePath } from "../skills/skills";
import { toolResult, untrustedToolResult } from "./result";
import { TEXT_EXTENSIONS } from "./vault-tools";
import { privatePathMessage, type PrivateMatcher } from "../vault/private-rules";
import {
  formatTextSlice,
  readSizeGuardrail,
  resolveLineWindow,
  sliceTextByLines,
  truncateToolOutput,
} from "../vault/truncate";

export const SKILL_TOOL_NAME = "skill";

const SKILL_ACTIONS = ["read", "read_file"] as const;
type SkillAction = (typeof SKILL_ACTIONS)[number];

const SkillParameters = Type.Object({
  action: Type.Unsafe<SkillAction>({
    type: "string",
    enum: [...SKILL_ACTIONS],
    description: "read: a skill's instructions; read_file: a file inside the skill folder",
  }),
  name: Type.String({ description: "exact skill name from the available_skills listing" }),
  path: Type.Optional(Type.String({ description: "read_file: path relative to the skill folder, e.g. references/api.md" })),
  offset: Type.Optional(Type.Number({ description: "read_file: start line, 1-based" })),
  limit: Type.Optional(Type.Number({ description: "read_file: max lines" })),
});

interface SkillParams {
  action: SkillAction;
  name: string;
  path?: string;
  offset?: number;
  limit?: number;
}

/**
 * The `skill` tool: read-only access to skills. `read` returns a skill's
 * instructions on demand, so skill bodies stay out of the system prompt.
 * `read_file` reads a resource (references/scripts/assets) confined to the
 * skill root, with the vault `read` guardrails (size, pagination, truncation).
 * Binary assets return a path hint instead of base64.
 */
export function createSkillTool(app: App, skills: Skill[], isIgnored: PrivateMatcher = () => false): AgentTool<typeof SkillParameters, unknown> {
  return {
    name: SKILL_TOOL_NAME,
    label: "Skill",
    description:
      "Read a skill. action read: the skill's instructions (body only; use the vault read tool on its SKILL.md for an exact copy). " +
      "action read_file: a file inside the skill folder.",
    parameters: SkillParameters,
    execute: async (_id, rawParams) => {
      const params: SkillParams = rawParams;
      const skill = requireSkill(skills, params.name);
      // The private rules cover skill files too (U5 deep check): a skill in a
      // private folder, or a private file inside a skill, stays unreadable.
      // Every path is checked: the built-in marker never matches a user rule, and a
      // prefix test would skip a real folder whose name starts with "(" (review of #429).
      if (skill.filePath && isIgnored(skill.filePath)) {
        throw new Error(privatePathMessage(skill.filePath, isIgnored));
      }
      if (normalizeAction(params.action) === "read") return readSkillBody(skill);
      const path = typeof params.path === "string" ? params.path.trim() : "";
      if (!path) throw new Error('skill: path is required for action "read_file".');
      const resolved = resolveSkillResourcePath(skill, path);
      if (isIgnored(resolved)) throw new Error(privatePathMessage(resolved, isIgnored));
      return readSkillFile(app, skill, { path, offset: params.offset, limit: params.limit });
    },
  };
}


function normalizeAction(value: unknown): SkillAction {
  if (value === "read" || value === "read_file") return value;
  throw new Error("skill: action must be read or read_file.");
}

function requireSkill(skills: Skill[], name: string): Skill {
  const skill = skills.find((s) => s.name === name);
  if (skill) return skill;
  const available = skills.map((s) => s.name).join(", ") || "(none)";
  throw new Error(`No skill named "${name}". Available: ${available}.`);
}

function readSkillBody(skill: Skill) {
  const body = formatSkillInvocation(skill);
  const frontmatter = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---`;
  const copyHint =
    skill.filePath && !skill.filePath.startsWith("(")
      ? `\n\nFrontmatter for exact copy:\n${frontmatter}\nSource file: ${skill.filePath} — use read for a byte-exact copy (frontmatter included).`
      : `\n\nFrontmatter for exact copy:\n${frontmatter}`;
  return toolResult(`${body}${copyHint}`, { action: "read", name: skill.name, filePath: skill.filePath });
}

async function readSkillFile(app: App, skill: Skill, params: { path: string; offset?: number; limit?: number }) {
  const resolved = resolveSkillResourcePath(skill, params.path);
  const entry = app.vault.getAbstractFileByPath(resolved);
  if (entry instanceof TFolder) {
    throw new Error(`${resolved} is a folder — use a file path inside the skill.`);
  }
  const file = app.vault.getFileByPath(resolved);
  // Binary asset guard (Option A: path hint, not base64) — check extension before reading
  const baseName = resolved.split("/").pop() ?? resolved;
  const hasDot = baseName.includes(".");
  const ext = hasDot ? (baseName.split(".").pop()?.toLowerCase() ?? "") : "";
  const fileExt = file?.extension?.toLowerCase() ?? "";
  const isText = !hasDot || TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(fileExt);
  // For unknown files (no TFile entry) we treat text-like extensions as text; others as binary
  if (!isText) {
    // Try to get size for hint; fallback to 0
    const size = file?.stat?.size ?? 0;
    const hint =
      `Binary file at ${resolved} — ${size.toLocaleString()} bytes, not displayed as text. ` +
      `This is a skill asset (e.g. image/PDF) referenced by "${skill.name}". Open it in the editor to view it.`;
    return untrustedToolResult(hint, { path: resolved, skill: skill.name, binary: true, size }, SKILL_TOOL_NAME);
  }
  if (!file) {
    // Fallback to adapter read for stale tree (same as loader's readVaultFile)
    try {
      const content = await app.vault.adapter.read(resolved);
      const guidance = readSizeGuardrail({
        path: resolved,
        size: content.length,
        offset: params.offset,
        limit: params.limit,
      });
      if (guidance) {
        return toolResult(truncateToolOutput(guidance), {
          path: resolved,
          skill: skill.name,
          tooLarge: true,
        });
      }
      return handleSkillFileContent(resolved, content, params, skill.name);
    } catch (error) {
      throw new Error(`File not found: ${resolved} (skill "${skill.name}" resource "${params.path}")`, {
        cause: error,
      });
    }
  }
  const guidance = readSizeGuardrail({
    path: resolved,
    size: file.stat?.size ?? 0,
    offset: params.offset,
    limit: params.limit,
  });
  if (guidance) {
    return toolResult(truncateToolOutput(guidance), {
      path: resolved,
      skill: skill.name,
      tooLarge: true,
    });
  }
  let content: string;
  try {
    content = await app.vault.cachedRead(file);
  } catch {
    // cachedRead can fail on mobile/web adapter stale tree; fall back to direct read
    content = await app.vault.adapter.read(resolved);
  }
  return handleSkillFileContent(resolved, content, params, skill.name);
}

function handleSkillFileContent(
  path: string,
  content: string,
  params: { offset?: number; limit?: number },
  skillName?: string,
) {
  const window = resolveLineWindow({
    offset: params.offset,
    limit: params.limit,
  });
  const slice = sliceTextByLines(content, window);
  const formatted = formatTextSlice(path, slice);
  return untrustedToolResult(
    formatted,
    {
      path,
      ...(skillName ? { skill: skillName } : {}),
      startLine: slice.startLine,
      endLine: slice.endLine,
      totalLines: slice.totalLines,
      truncated: slice.truncated,
    },
    SKILL_TOOL_NAME,
  );
}
