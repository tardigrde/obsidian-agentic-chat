import { describe, expect, it } from "vitest";
import { TFolder, type App } from "obsidian";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { PluginService } from "../src/plugins/service";
import { pluginMcpServerId } from "../src/plugins/loader";
import { AGENT_PLUGINS_SCHEMA_ID } from "../src/plugins/manifest";
import { FakeApp } from "./helpers/fake-vault";

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

function serviceFor(app: App, current: AgenticChatSettings, onSave?: () => void | Promise<void>) {
  return new PluginService(app, () => current, onSave);
}

describe("PluginService.generateMcpServerPackage", () => {
  it("writes a real package with plugin.json and mcp.json", async () => {
    const app = await seed();
    const result = await serviceFor(app, settings()).generateMcpServerPackage({
      serverName: "Deploy API",
      url: "https://deploy.example.com/mcp",
    });

    expect(result).toMatchObject({
      rootPath: ".agentic-plugins/deploy-api",
      pluginName: "deploy-api",
      serverKey: "deploy_api",
    });
    const manifest = app.vault.getAbstractFileByPath(".agentic-plugins/deploy-api/plugin.json");
    expect(manifest).not.toBeNull();
    const mcp = app.vault.getAbstractFileByPath(".agentic-plugins/deploy-api/mcp.json");
    expect(mcp).not.toBeNull();
  });

  it("writes spec-valid documents the loader accepts", async () => {
    const app = await seed();
    await serviceFor(app, settings()).generateMcpServerPackage({
      serverName: "docs",
      url: "https://docs.example.com/mcp",
    });

    const current = settings();
    const plugins = await serviceFor(app, current).reload();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ name: "docs", auditStatus: "ok" });
    expect(plugins[0]?.mcpServers.map((server) => server.id)).toEqual([
      pluginMcpServerId("docs", "docs"),
    ]);
    expect(plugins[0]?.mcpServers[0]?.url).toBe("https://docs.example.com/mcp");
  });

  it("picks a suffixed name when the package already exists", async () => {
    const app = await seed();
    await serviceFor(app, settings()).generateMcpServerPackage({
      serverName: "docs",
      url: "https://docs.example.com/mcp",
    });
    const second = await serviceFor(app, settings()).generateMcpServerPackage({
      serverName: "docs",
      url: "https://docs.example.com/mcp",
    });

    expect(second.pluginName).toBe("docs-2");
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/docs-2/plugin.json")).not.toBeNull();
  });
});

describe("PluginService.auditText", () => {
  it("summarizes every package with counts and reports", async () => {
    const app = await seed();
    await serviceFor(app, settings()).generateMcpServerPackage({
      serverName: "docs",
      url: "https://docs.example.com/mcp",
    });
    const current = settings();
    const service = serviceFor(app, current);
    const plugins = await service.reload();

    const text = service.auditText(plugins);
    expect(text).toContain("**docs** (.agentic-plugins/docs)");
    expect(text).toContain("0 skills, 1 MCP server");
    expect(text).toContain("enabled");
  });

  it("serializes plugin.json with the canonical schema id", async () => {
    const app = await seed();
    const service = serviceFor(app, settings());
    await service.generateMcpServerPackage({ serverName: "docs", url: "https://docs.example.com/mcp" });
    const manifest = app.vault.getAbstractFileByPath(".agentic-plugins/docs/plugin.json");
    expect(manifest).not.toBeNull();
    const raw = await app.vault.cachedRead(manifest as never);
    expect(JSON.parse(raw)).toMatchObject({ $schema: AGENT_PLUGINS_SCHEMA_ID, name: "docs" });
  });
});

describe("PluginService.install recovery", () => {
  it("restores a backup when the target is missing before sweeping", async () => {
    const app = await seed();
    const manifest = JSON.stringify({
      $schema: AGENT_PLUGINS_SCHEMA_ID,
      name: "docs",
      version: "1.0.0",
      description: "Docs tools",
    });
    await app.vault.createFolder(".agentic-plugins/.importing-backup-docs");
    await app.vault.create(".agentic-plugins/.importing-backup-docs/plugin.json", manifest);

    const plugins = await serviceFor(app, settings()).reload();

    expect(app.vault.getAbstractFileByPath(".agentic-plugins/docs/plugin.json")).not.toBeNull();
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/.importing-backup-docs")).toBeNull();
    expect(plugins.map((plugin) => plugin.name)).toContain("docs");
  });

  it("removes a traversal backup name without renaming outside the plugins folder", async () => {
    const app = await seed();
    await app.vault.createFolder(".agentic-plugins/.importing-backup-..");
    await app.vault.create(".agentic-plugins/.importing-backup-../plugin.json", "{}");
    const renames: Array<[string, string]> = [];
    const adapter = app.vault.adapter;
    const originalRename = adapter.rename.bind(adapter);
    adapter.rename = async (from, to) => {
      renames.push([from, to]);
      return originalRename(from, to);
    };

    await serviceFor(app, settings()).reload();

    expect(renames).toEqual([]);
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/.importing-backup-..")).toBeNull();
    expect(app.vault.getAbstractFileByPath(".agentic-plugins")).not.toBeNull();
  });

  it("keeps a backup when a regular file occupies the target", async () => {
    const app = await seed();
    const manifest = JSON.stringify({
      $schema: AGENT_PLUGINS_SCHEMA_ID,
      name: "docs",
      version: "1.0.0",
      description: "Docs tools",
    });
    await app.vault.create(".agentic-plugins/docs", "not a folder");
    await app.vault.createFolder(".agentic-plugins/.importing-backup-docs");
    await app.vault.create(".agentic-plugins/.importing-backup-docs/plugin.json", manifest);

    await serviceFor(app, settings()).reload();

    expect(app.vault.getAbstractFileByPath(".agentic-plugins/docs")).not.toBeNull();
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/.importing-backup-docs")).not.toBeNull();
  });

  it("restores every backup after the first restore mutates the folder list", async () => {
    const root = new TFolder();
    root.path = ".agentic-plugins";
    root.name = ".agentic-plugins";
    const backup = (name: string): TFolder => {
      const folder = new TFolder();
      folder.path = `.agentic-plugins/.importing-backup-${name}`;
      folder.name = `.importing-backup-${name}`;
      return folder;
    };
    const alpha = backup("alpha");
    const beta = backup("beta");
    root.children = [alpha, beta];
    const renames: Array<[string, string]> = [];
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => (path === root.path ? root : undefined),
        adapter: {
          exists: async () => false,
          rename: async (from: string, to: string) => {
            renames.push([from, to]);
            // Real vault trees drop the renamed child from the live array.
            const index = root.children.findIndex((child) => child.path === from);
            if (index >= 0) root.children.splice(index, 1);
          },
        },
      },
    } as unknown as App;

    await serviceFor(app, settings()).sweepImportStages();

    expect(renames).toEqual([
      [alpha.path, ".agentic-plugins/alpha"],
      [beta.path, ".agentic-plugins/beta"],
    ]);
  });
});

describe("PluginService cache invalidation", () => {
  it("invalidateFor drops the cache only for paths inside the plugins folder", async () => {
    const app = await seed();
    await app.vault.createFolder(".agentic-plugins/docs");
    const current = settings();
    const service = serviceFor(app, current);

    await service.load();
    expect(service.hasCache()).toBe(true);

    expect(service.invalidateFor("Notes/elsewhere.md")).toBe(false);
    expect(service.hasCache()).toBe(true);

    expect(service.invalidateFor(".agentic-plugins/docs/plugin.json")).toBe(true);
    expect(service.hasCache()).toBe(false);
    expect(service.getLoaded()).toEqual([]);
  });

  it("invalidateFor matches the folder itself", async () => {
    const app = await seed();
    const service = serviceFor(app, settings());
    await service.load();
    expect(service.invalidateFor(".agentic-plugins")).toBe(true);
    expect(service.hasCache()).toBe(false);
  });
});
