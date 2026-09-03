import { type AgentTool, type Skill, formatSkillInvocation } from "@earendil-works/pi-agent-core";
import { TFolder, type App } from "obsidian";
import { Type } from "typebox";
import { resolveSkillResourcePath } from "../skills/skills";
import { wrapToolOutputTruncated } from "./tool-output-wrapper";
import { TEXT_EXTENSIONS } from "./vault-tools";
import {
  formatTextSlice,
  readSizeGuardrail,
  resolveLineWindow,
  sliceTextByLines,
  truncateToolOutput,
} from "../vault/truncate";

const ReadSkillParameters = Type.Object({
  name: Type.String({
    description: "exact skill name from the available_skills listing",
  }),
});

const ReadSkillFileParameters = Type.Object({
  skill: Type.String({ description: "skill name" }),
  path: Type.String({ description: "relative path in skill folder, e.g. references/api.md" }),
  offset: Type.Optional(Type.Number({ description: "start line, 1-based" })),
  limit: Type.Optional(Type.Number({ description: "max lines" })),
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
    description: "Skill instructions by name. Body only; read for exact copy.",
    parameters: ReadSkillParameters,
    execute: async (_id, params) => {
      const skill = skills.find((s) => s.name === params.name);
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ") || "(none)";
        throw new Error(`No skill named "${params.name}". Available: ${available}.`);
      }
      const body = formatSkillInvocation(skill);
      const frontmatter =
        `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---`;
      const copyHint =
        skill.filePath && !skill.filePath.startsWith("(")
          ? `\n\nFrontmatter for exact copy:\n${frontmatter}\nSource file: ${skill.filePath} — use read for a byte-exact copy (frontmatter included).`
          : `\n\nFrontmatter for exact copy:\n${frontmatter}`;
      return {
        content: [{ type: "text", text: `${body}${copyHint}` }],
        details: { name: skill.name, filePath: skill.filePath },
      };
    },
  };
}

/**
 * Create the `read_skill_file` tool: on-demand loading of skill resources
 * (scripts/references/assets) confined to the skill root. Mirrors the vault
 * `read` guardrails (size, pagination, truncation) but resolves the path
 * relative to the skill directory and enforces confinement. Binary assets
 * return a path hint (Option A) instead of base64.
 */
export function createReadSkillFileTool(app: App, skills: Skill[]): AgentTool<typeof ReadSkillFileParameters, unknown> {
  return {
    name: "read_skill_file",
    label: "Read skill file",
    description: "Read a file inside a skill folder (references/scripts/assets) relative to skill root. Binary assets return a path hint.",
    parameters: ReadSkillFileParameters,
    execute: async (_id, params) => {
      const skill = skills.find((s) => s.name === params.skill);
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ") || "(none)";
        throw new Error(`No skill named "${params.skill}". Available: ${available}.`);
      }
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
          `This is a skill asset (e.g. image/PDF) referenced by "${skill.name}". Open in editor or use ls to verify.`;
        return {
          content: [{ type: "text", text: wrapToolOutputTruncated(truncateToolOutput(hint), "read_skill_file") }],
          details: { path: resolved, skill: skill.name, binary: true, size },
        };
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
            return {
              content: [{ type: "text", text: truncateToolOutput(guidance) }],
              details: { path: resolved, skill: skill.name, tooLarge: true },
            };
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
        return {
          content: [{ type: "text", text: truncateToolOutput(guidance) }],
          details: { path: resolved, skill: skill.name, tooLarge: true },
        };
      }
      let content: string;
      try {
        content = await app.vault.cachedRead(file);
      } catch {
        // cachedRead can fail on mobile/web adapter stale tree; fall back to direct read
        content = await app.vault.adapter.read(resolved);
      }
      return handleSkillFileContent(resolved, content, params, skill.name);
    },
  };
}

function handleSkillFileContent(
  path: string,
  content: string,
  params: { offset?: number; limit?: number },
  skillName?: string,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
  const window = resolveLineWindow({
    offset: params.offset,
    limit: params.limit,
  });
  const slice = sliceTextByLines(content, window);
  const formatted = formatTextSlice(path, slice);
  return {
    content: [{ type: "text", text: wrapToolOutputTruncated(formatted, "read_skill_file") }],
    details: {
      path,
      ...(skillName ? { skill: skillName } : {}),
      startLine: slice.startLine,
      endLine: slice.endLine,
      totalLines: slice.totalLines,
      truncated: slice.truncated,
    },
  };
}
