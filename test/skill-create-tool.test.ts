import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/settings";
import { buildAgentParentTools, EMPTY_AGENT_RUNTIME_RESOURCES } from "../src/agent/runtime-resources";
import { createCreateSkillTool, type SkillScaffolder } from "../src/tools/skill-tools";
import { ReadMemo } from "../src/vault/read-memo";
import type { WebFetcher } from "../src/tools/web-fetch";

const noopFetcher: WebFetcher = async () => ({ status: 200, text: "", headers: {} });

function scaffolderFor(
  scaffoldSkill: SkillScaffolder["scaffoldSkill"],
  existing: string[] = [],
): SkillScaffolder {
  return {
    packageExists: async (name: string) => existing.includes(name),
    scaffoldSkill,
  };
}

describe("create_skill tool", () => {
  it("scaffolds through the wizard writer and reports the package path", async () => {
    const seen: unknown[] = [];
    const tool = createCreateSkillTool(
      scaffolderFor(async (input) => {
        seen.push(input);
        return { rootPath: ".agentic-plugins/my-skill", name: "my-skill", updated: false, skills: 1 };
      }),
    );
    expect(tool.name).toBe("create_skill");
    const result = await tool.execute("call-1", {
      name: "my-skill",
      description: "Does the thing.",
      body: "# My skill",
    }, undefined);
    expect(seen).toEqual([{ name: "my-skill", description: "Does the thing.", body: "# My skill" }]);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain(".agentic-plugins/my-skill");
    expect((result.content[0] as { text: string }).text).toContain("cannot be undone");
    expect(result.details).toMatchObject({ name: "my-skill", updated: false });
  });

  it("refuses to replace an existing package without overwrite and reports alreadyExists", async () => {
    let called = false;
    const tool = createCreateSkillTool(
      scaffolderFor(
        async () => {
          called = true;
          return { rootPath: ".agentic-plugins/my-skill", name: "my-skill", updated: true, skills: 1 };
        },
        ["my-skill"],
      ),
    );
    const result = await tool.execute("call-1", { name: "my-skill", description: "D", body: "B" }, undefined);
    expect(called).toBe(false);
    expect((result.content[0] as { text: string }).text).toContain("already exists");
    expect(result.details).toMatchObject({ alreadyExists: true });
  });

  it("replaces only with explicit overwrite after confirmation", async () => {
    const tool = createCreateSkillTool(
      scaffolderFor(
        async () => ({ rootPath: ".agentic-plugins/my-skill", name: "my-skill", updated: true, skills: 1 }),
        ["my-skill"],
      ),
    );
    const result = await tool.execute(
      "call-1",
      { name: "my-skill", description: "D", body: "B", overwrite: true },
      undefined,
    );
    expect((result.content[0] as { text: string }).text).toContain("cannot be undone");
    expect(result.details).toMatchObject({ updated: true });
  });

  it("surfaces writer validation errors to the model", async () => {
    const tool = createCreateSkillTool(
      scaffolderFor(async () => {
        throw new Error("Skill name must contain at least one letter or digit.");
      }),
    );
    await expect(
      tool.execute("call-1", { name: "abc", description: "", body: "B" }, undefined),
    ).rejects.toThrow(/letter or digit/);
  });

  it("appears in parent tools only when a scaffolder is wired", () => {
    const base = {
      app: { vault: {}, workspace: {} } as unknown as App,
      settings: { ...DEFAULT_SETTINGS, web: { ...DEFAULT_SETTINGS.web, enabled: true } },
      resources: { ...EMPTY_AGENT_RUNTIME_RESOURCES },
      readMemo: new ReadMemo(),
      webFetch: noopFetcher,
    };
    const without = buildAgentParentTools({ ...base }).tools.map((tool) => tool.name);
    expect(without).not.toContain("create_skill");
    const scaffolder = scaffolderFor(async () => ({
      rootPath: ".agentic-plugins/x",
      name: "x",
      updated: false,
      skills: 1,
    }));
    const withTool = buildAgentParentTools({ ...base, skillScaffolder: scaffolder }).tools.map((tool) => tool.name);
    expect(withTool).toContain("create_skill");
  });
});
