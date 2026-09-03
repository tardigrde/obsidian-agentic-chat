import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { PluginService } from "../src/plugins/service";
import { USER_SKILLS_PACKAGE } from "../src/plugins/manifest";
import { loadPlugins, type LoadedPlugin } from "../src/plugins/loader";
import { validatePluginManifest } from "../src/plugins/manifest";
import { SELF_KNOWLEDGE_SKILL } from "../src/skills/builtin-skills";
import {
  composeAgentSystemPrompt,
  EMPTY_AGENT_RUNTIME_RESOURCES,
} from "../src/agent/runtime-resources";
import { FakeApp } from "./helpers/fake-vault";

function settings(): AgenticChatSettings {
  return { ...DEFAULT_SETTINGS, plugins: { ...DEFAULT_SETTINGS.plugins, enabled: {} } };
}

describe("my-skills user collection", () => {
  it("materializes an empty but spec-valid package only when absent", async () => {
    const app = new FakeApp();
    await app.vault.createFolder(".agentic-plugins");
    const service = new PluginService(app as unknown as App, settings);
    expect(await service.ensureMySkillsMaterialized()).toBe(true);
    expect(await service.ensureMySkillsMaterialized()).toBe(false);

    const raw = app.vault.contentOf(`.agentic-plugins/${USER_SKILLS_PACKAGE}/plugin.json`);
    expect(raw).toBeDefined();
    expect(validatePluginManifest(raw as string).fatal).toBeNull();
    expect(app.vault.contentOf(`.agentic-plugins/${USER_SKILLS_PACKAGE}/README.md`)).toContain("personal skill collection");
  });

  it("never overwrites user content", async () => {
    const app = new FakeApp();
    await app.vault.createFolder(".agentic-plugins");
    const service = new PluginService(app as unknown as App, settings);
    await service.ensureMySkillsMaterialized();
    await app.vault.create(
      `.agentic-plugins/${USER_SKILLS_PACKAGE}/skills/notes/SKILL.md`,
      "---\nname: notes\ndescription: N\n---\n# Notes\n",
    );
    expect(await service.ensureMySkillsMaterialized()).toBe(false);
    expect(app.vault.contentOf(`.agentic-plugins/${USER_SKILLS_PACKAGE}/skills/notes/SKILL.md`)).toContain("# Notes");
  });

  it("loads as ok with 0 skills and 0 servers (empty is valid per §6.2)", async () => {
    const app = new FakeApp();
    await app.vault.createFolder(".agentic-plugins");
    const service = new PluginService(app as unknown as App, settings);
    await service.ensureMySkillsMaterialized();
    const plugins = await loadPlugins(app as unknown as App);
    const mine = plugins.find((plugin) => plugin.name === USER_SKILLS_PACKAGE);
    expect(mine).toMatchObject({ auditStatus: "ok", manifestProblem: null });
    expect(mine?.skills).toHaveLength(0);
    expect(mine?.mcpServers).toHaveLength(0);
  });

  it("treats my-skills as first-party (no untrusted boundary), unlike third-party packs", () => {
    const pack = (name: string, rootPath?: string): LoadedPlugin => ({
      rootPath: rootPath ?? `.agentic-plugins/${name}`,
      name,
      enabled: true,
      manifestProblem: null,
      skills: [SELF_KNOWLEDGE_SKILL],
      skillReports: [],
      mcpValidation: null,
      mcpServers: [],
      reports: [],
      auditStatus: "ok",
    });
    const promptFor = (plugins: LoadedPlugin[]): string =>
      composeAgentSystemPrompt(settings(), { ...EMPTY_AGENT_RUNTIME_RESOURCES, plugins, skills: [] }, "");
    expect(promptFor([pack(USER_SKILLS_PACKAGE)])).not.toContain("SECURITY BOUNDARY");
    expect(promptFor([pack("some-import")])).toContain("SECURITY BOUNDARY");
  });

  it("does not trust a third-party package that merely claims a first-party name", () => {
    const squat: LoadedPlugin = {
      rootPath: ".agentic-plugins-evil/my-skills",
      name: USER_SKILLS_PACKAGE,
      enabled: true,
      manifestProblem: null,
      skills: [SELF_KNOWLEDGE_SKILL],
      skillReports: [],
      mcpValidation: null,
      mcpServers: [],
      reports: [],
      auditStatus: "ok",
    };
    const prompt = composeAgentSystemPrompt(
      settings(),
      { ...EMPTY_AGENT_RUNTIME_RESOURCES, plugins: [squat], skills: [] },
      "",
    );
    expect(prompt).toContain("SECURITY BOUNDARY");
  });
});
