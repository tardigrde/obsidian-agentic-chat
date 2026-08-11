import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { PluginService } from "../src/plugins/service";
import { pluginMcpServerId } from "../src/plugins/loader";
import { createMcpServerSettings } from "../src/mcp/settings";
import { AGENT_PLUGINS_SCHEMA_ID } from "../src/plugins/manifest";
import { FakeApp, FakeVault } from "./helpers/fake-vault";

async function seed(): Promise<App> {
  const app = new FakeApp();
  await app.vault.createFolder(".agentic-plugins");
  return app as unknown as App;
}

function settings(overrides: Partial<AgenticChatSettings> = {}): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    plugins: { ...DEFAULT_SETTINGS.plugins, enabled: {} },
    mcp: { ...DEFAULT_SETTINGS.mcp, servers: [] },
    ...overrides,
  };
}

function legacyServer(name: string, url: string) {
  return {
    ...createMcpServerSettings({ id: name, name, url, enabled: true, approval: "ask", authType: "none" }),
    headers: {},
  };
}

function serviceFor(app: App, current: AgenticChatSettings, onSave?: () => void | Promise<void>) {
  return new PluginService(app, () => current, onSave);
}

describe("PluginService.migrateLegacyMcpServers", () => {
  it("migrates HTTPS servers into a legacy-mcp package and remaps state", async () => {
    const app = await seed();
    const current = settings({
      mcp: {
        ...DEFAULT_SETTINGS.mcp,
        servers: [legacyServer("prod", "https://api.example.com/mcp")],
      },
    });
    const save = vi.fn();
    const result = await serviceFor(app, current, save).migrateLegacyMcpServers(current);

    expect(result).toEqual({ migrated: 1, skipped: [] });
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/legacy-mcp/plugin.json")).not.toBeNull();
    const mcpDoc = app.vault.getAbstractFileByPath(".agentic-plugins/legacy-mcp/mcp.json");
    expect(mcpDoc).not.toBeNull();
    expect(current.mcp.servers[0]).toMatchObject({
      id: pluginMcpServerId("legacy-mcp", "prod"),
      name: "legacy-mcp: prod",
      url: "https://api.example.com/mcp",
      source: "generated",
      pluginRoot: ".agentic-plugins/legacy-mcp",
      enabled: true,
    });
    expect(current.plugins.migratedLegacy).toBe(true);
    expect(save).toHaveBeenCalled();
  });

  it("migrates loopback http servers", async () => {
    const app = await seed();
    const current = settings({
      mcp: {
        ...DEFAULT_SETTINGS.mcp,
        servers: [legacyServer("local", "http://127.0.0.1:3000/mcp")],
      },
    });
    const result = await serviceFor(app, current).migrateLegacyMcpServers(current);
    expect(result.migrated).toBe(1);
    expect(current.mcp.servers[0]?.url).toBe("http://127.0.0.1:3000/mcp");
  });

  it("skips non-HTTPS non-loopback servers, leaves settings untouched, and never marks done", async () => {
    const app = await seed();
    const current = settings({
      mcp: {
        ...DEFAULT_SETTINGS.mcp,
        servers: [legacyServer("insecure", "http://intranet.example.com/mcp"), legacyServer("bad", "not-a-url")],
      },
    });
    const save = vi.fn();
    const result = await serviceFor(app, current, save).migrateLegacyMcpServers(current);

    expect(result).toEqual({ migrated: 0, skipped: ["insecure", "bad"] });
    expect(current.plugins.migratedLegacy).toBe(false);
    expect(current.mcp.servers).toHaveLength(2);
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/legacy-mcp/plugin.json")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps skipped servers in settings when some servers migrate", async () => {
    const app = await seed();
    const current = settings({
      mcp: {
        ...DEFAULT_SETTINGS.mcp,
        servers: [
          legacyServer("prod", "https://api.example.com/mcp"),
          legacyServer("insecure", "http://intranet.example.com/mcp"),
        ],
      },
    });
    const result = await serviceFor(app, current).migrateLegacyMcpServers(current);

    expect(result).toEqual({ migrated: 1, skipped: ["insecure"] });
    expect(current.mcp.servers.map((server) => server.id)).toEqual([
      pluginMcpServerId("legacy-mcp", "prod"),
      "insecure",
    ]);
    const skipped = current.mcp.servers.find((server) => server.id === "insecure");
    expect(skipped).toMatchObject({ url: "http://intranet.example.com/mcp", source: "user", enabled: true });
  });

  it("does not create a duplicate package when a crashed run left one behind", async () => {
    const app = await seed();
    await app.vault.createFolder(".agentic-plugins/legacy-mcp");
    await app.vault.create(
      ".agentic-plugins/legacy-mcp/plugin.json",
      JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_ID, name: "legacy-mcp" }),
    );
    const current = settings({
      mcp: {
        ...DEFAULT_SETTINGS.mcp,
        servers: [legacyServer("prod", "https://api.example.com/mcp")],
      },
    });
    const result = await serviceFor(app, current).migrateLegacyMcpServers(current);

    expect(result.migrated).toBe(1);
    expect(current.mcp.servers[0]?.pluginRoot).toBe(".agentic-plugins/legacy-mcp");
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/legacy-mcp-2/plugin.json")).toBeNull();
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/legacy-mcp/mcp.json")).not.toBeNull();
  });

  it("does not reuse a user-authored legacy-mcp package whose servers differ", async () => {
    const app = await seed();
    await app.vault.createFolder(".agentic-plugins/legacy-mcp");
    await app.vault.create(
      ".agentic-plugins/legacy-mcp/plugin.json",
      JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_ID, name: "legacy-mcp" }),
    );
    await app.vault.create(
      ".agentic-plugins/legacy-mcp/mcp.json",
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { other: { type: "streamable-http", url: "https://other.example/mcp" } },
      }),
    );
    const current = settings({
      mcp: {
        ...DEFAULT_SETTINGS.mcp,
        servers: [legacyServer("prod", "https://api.example.com/mcp")],
      },
    });
    const result = await serviceFor(app, current).migrateLegacyMcpServers(current);

    expect(result.migrated).toBe(1);
    expect(current.mcp.servers[0]?.pluginRoot).toBe(".agentic-plugins/legacy-mcp-2");
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/legacy-mcp-2/mcp.json")).not.toBeNull();
    const legacyVault = app.vault as unknown as FakeVault;
    expect(legacyVault.contentOf(".agentic-plugins/legacy-mcp/mcp.json")).toContain("other.example");
  });

  it("is a no-op after the migration flag is set", async () => {
    const app = await seed();
    const current = settings({
      mcp: { ...DEFAULT_SETTINGS.mcp, servers: [legacyServer("prod", "https://api.example.com/mcp")] },
      plugins: { ...DEFAULT_SETTINGS.plugins, migratedLegacy: true },
    });
    const result = await serviceFor(app, current).migrateLegacyMcpServers(current);
    expect(result).toEqual({ migrated: 0, skipped: [] });
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/legacy-mcp/plugin.json")).toBeNull();
  });
});

describe("PluginService.migrateLegacySkillsFolder", () => {
  it("copies legacy skills and templates into an agentic-skills package", async () => {
    const app = await seed();
    await app.vault.createFolder("Skills");
    await app.vault.create("Skills/My Skill.md", "---\ndescription: Does things\n---\nBody one.");
    await app.vault.createFolder("Skills/nested");
    await app.vault.create("Skills/nested/SKILL.md", "---\nname: nested-skill\n---\nBody nested.");
    await app.vault.createFolder("Templates");
    await app.vault.create("Templates/note-template.md", "Plain template body.");

    const current = settings();
    const result = await serviceFor(app, current).migrateLegacySkillsFolder(current, {
      skillsFolder: "Skills",
      templatesFolder: "Templates",
    });

    expect(result).toEqual({ migrated: 3, skipped: 0 });
    expect(current.plugins.skillsMigrated).toBe(true);
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/agentic-skills/plugin.json")).not.toBeNull();

    const skillDoc = app.vault.getAbstractFileByPath(".agentic-plugins/agentic-skills/skills/my-skill/SKILL.md");
    expect(skillDoc).not.toBeNull();
    const mySkill = await app.vault.cachedRead(skillDoc as never);
    expect(mySkill).toContain('name: "My Skill"');
    expect(mySkill).toContain('description: "Does things"');
    expect(mySkill).toContain("Body one.");

    expect(app.vault.getAbstractFileByPath(".agentic-plugins/agentic-skills/skills/nested-skill/SKILL.md")).not.toBeNull();
    const templateDoc = app.vault.getAbstractFileByPath(
      ".agentic-plugins/agentic-skills/skills/note-template/SKILL.md",
    );
    expect(templateDoc).not.toBeNull();
    const template = await app.vault.cachedRead(templateDoc as never);
    expect(template).toContain("Plain template body.");
  });

  it("lets skills win over templates of the same name", async () => {
    const app = await seed();
    await app.vault.createFolder("Skills");
    await app.vault.create("Skills/shared.md", "---\nname: shared\n---\nSkill body.");
    await app.vault.createFolder("Templates");
    await app.vault.create("Templates/shared.md", "---\nname: shared\n---\nTemplate body.");

    const current = settings();
    await serviceFor(app, current).migrateLegacySkillsFolder(current, {
      skillsFolder: "Skills",
      templatesFolder: "Templates",
    });

    const doc = app.vault.getAbstractFileByPath(".agentic-plugins/agentic-skills/skills/shared/SKILL.md");
    expect(doc).not.toBeNull();
    expect(await app.vault.cachedRead(doc as never)).toContain("Skill body.");
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/agentic-skills/skills/shared-2/SKILL.md")).toBeNull();
  });

  it("marks the migration done without creating a package when no folders were configured", async () => {
    const app = await seed();
    const current = settings();
    const save = vi.fn();
    const result = await serviceFor(app, current, save).migrateLegacySkillsFolder(current, {});
    expect(result).toEqual({ migrated: 0, skipped: 0 });
    expect(current.plugins.skillsMigrated).toBe(true);
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/agentic-skills/plugin.json")).toBeNull();
    expect(save).toHaveBeenCalled();
  });

  it("marks the migration done when the folders exist but hold no skill documents", async () => {
    const app = await seed();
    await app.vault.createFolder("Skills");
    await app.vault.create("Skills/empty.md", "---\nname: empty\n---\n");
    const current = settings();
    const result = await serviceFor(app, current).migrateLegacySkillsFolder(current, { skillsFolder: "Skills" });
    expect(result).toEqual({ migrated: 0, skipped: 1 });
    expect(current.plugins.skillsMigrated).toBe(true);
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/agentic-skills/plugin.json")).toBeNull();
  });

  it("reuses a package left behind by a crashed run without duplicating documents", async () => {
    const app = await seed();
    await app.vault.createFolder(".agentic-plugins/agentic-skills");
    await app.vault.create(
      ".agentic-plugins/agentic-skills/plugin.json",
      JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_ID, name: "agentic-skills" }),
    );
    await app.vault.createFolder(".agentic-plugins/agentic-skills/skills");
    await app.vault.createFolder(".agentic-plugins/agentic-skills/skills/alpha");
    await app.vault.create(".agentic-plugins/agentic-skills/skills/alpha/SKILL.md", "---\nname: alpha\n---\nFirst.");
    await app.vault.createFolder("Skills");
    await app.vault.create("Skills/alpha.md", "---\nname: alpha\n---\nFirst.");
    await app.vault.create("Skills/beta.md", "---\nname: beta\n---\nSecond.");

    const current = settings();
    const result = await serviceFor(app, current).migrateLegacySkillsFolder(current, { skillsFolder: "Skills" });

    expect(result.migrated).toBe(2);
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/agentic-skills/skills/alpha/SKILL.md")).not.toBeNull();
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/agentic-skills/skills/beta/SKILL.md")).not.toBeNull();
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/agentic-skills-2/plugin.json")).toBeNull();
  });

  it("is a no-op after the migration flag is set", async () => {
    const app = await seed();
    await app.vault.createFolder("Skills");
    await app.vault.create("Skills/alpha.md", "---\nname: alpha\n---\nBody.");
    const current = settings({ plugins: { ...DEFAULT_SETTINGS.plugins, skillsMigrated: true } });
    const result = await serviceFor(app, current).migrateLegacySkillsFolder(current, { skillsFolder: "Skills" });
    expect(result).toEqual({ migrated: 0, skipped: 0 });
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/agentic-skills/plugin.json")).toBeNull();
  });
});
