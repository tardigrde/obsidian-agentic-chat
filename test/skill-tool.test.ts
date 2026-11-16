import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { createSkillTool } from "../src/tools/skill-tool";
import { SELF_KNOWLEDGE_SKILL, DEEP_RESEARCH_SKILL } from "../src/skills/builtin-skills";
import { FakeApp } from "./helpers/fake-vault";

const noApp = { vault: {} } as unknown as App;

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((c) => c.type === "text")?.text ?? "";
}

describe("skill tool: action read", () => {
  const skills = [SELF_KNOWLEDGE_SKILL, DEEP_RESEARCH_SKILL];
  const tool = createSkillTool(noApp, skills);

  it("declares action as a schema enum, so a wrong action fails validation before execution", () => {
    const action = (tool.parameters as unknown as { properties: Record<string, { enum?: string[] }> }).properties.action;
    expect(action.enum).toEqual(["read", "read_file"]);
  });

  it("returns the full skill content for a matching name", async () => {
    const text = textOf(await tool.execute("call-1", { action: "read", name: "self-knowledge" }));
    expect(text).toContain("Self-knowledge");
    expect(text).toContain("Tools inventory");
    expect(text).toContain("Doomloop guard");
  });

  it("returns the full skill content for deep-research", async () => {
    const text = textOf(await tool.execute("call-2", { action: "read", name: "deep-research" }));
    expect(text).toContain("Deep research");
    expect(text).toContain("subagent");
  });

  it("throws for an unknown skill name", async () => {
    await expect(tool.execute("call-3", { action: "read", name: "nonexistent" })).rejects.toThrow("No skill named");
  });

  it("throws for an unknown action", async () => {
    await expect(tool.execute("call-3", { action: "load" as never, name: "self-knowledge" })).rejects.toThrow(
      "action must be read or read_file",
    );
  });

  it("includes frontmatter and a copy hint so its output is not used for lossy copies", async () => {
    const vaultSkill = {
      name: "gemini-image",
      description: "Generate images with Gemini.",
      content: "# Gemini\nBody here.",
      filePath: ".agentic-plugins/gemini-image/skills/gemini-image/SKILL.md",
    };
    const vaultTool = createSkillTool(noApp, [vaultSkill]);
    const text = textOf(await vaultTool.execute("call-4", { action: "read", name: "gemini-image" }));
    expect(text).toContain("name: gemini-image");
    expect(text).toContain('description: "Generate images with Gemini."');
    expect(text).toContain(".agentic-plugins/gemini-image/skills/gemini-image/SKILL.md");
    expect(text).toMatch(/use read .*byte-exact copy/i);
  });
});

describe("skill tool: action read_file", () => {
  const skillPath = ".agentic-plugins/notes/skills/notes";
  const skill = {
    name: "notes",
    description: "Note helpers.",
    content: "# Notes",
    filePath: `${skillPath}/SKILL.md`,
  };

  async function appWithFiles(): Promise<App> {
    const app = new FakeApp();
    await app.vault.createFolder(`${skillPath}/references`);
    await app.vault.create(`${skillPath}/references/api.md`, "line one\nline two\nline three");
    return app as unknown as App;
  }

  it("reads a file inside the skill folder with a line window", async () => {
    const tool = createSkillTool(await appWithFiles(), [skill]);
    const result = await tool.execute("call-1", {
      action: "read_file",
      name: "notes",
      path: "references/api.md",
      offset: 2,
      limit: 1,
    });
    expect(textOf(result)).toContain("line two");
    expect(textOf(result)).not.toContain("line three");
    expect(result.details).toMatchObject({ path: `${skillPath}/references/api.md`, skill: "notes", startLine: 2 });
  });

  it("requires a path", async () => {
    const tool = createSkillTool(await appWithFiles(), [skill]);
    await expect(tool.execute("call-2", { action: "read_file", name: "notes" })).rejects.toThrow(
      'path is required for action "read_file"',
    );
  });

  it("refuses a path that escapes the skill folder", async () => {
    const tool = createSkillTool(await appWithFiles(), [skill]);
    await expect(
      tool.execute("call-3", { action: "read_file", name: "notes", path: "../../../secret.md" }),
    ).rejects.toThrow();
  });

  it("returns a path hint, not bytes, for a binary asset", async () => {
    const tool = createSkillTool(await appWithFiles(), [skill]);
    const result = await tool.execute("call-4", { action: "read_file", name: "notes", path: "assets/logo.png" });
    expect(textOf(result)).toContain("Binary file at");
    expect(result.details).toMatchObject({ binary: true, skill: "notes" });
  });
});
