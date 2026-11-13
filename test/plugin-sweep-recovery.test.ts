import { describe, expect, it, vi } from "vitest";
import { TFolder, type App } from "obsidian";
import { AgenticChatSettingTab } from "../src/settings";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings-schema";
import { PluginService } from "../src/plugins/service";
import { pluginMcpServerId } from "../src/plugins/loader";
import { createMcpServerState } from "../src/mcp/settings";
import { AGENT_PLUGINS_SCHEMA_ID } from "../src/plugins/manifest";
import { FakeApp } from "./helpers/fake-vault";
import AgenticChatPlugin from "../src/main";

vi.mock("../src/llm/pricing-cache", () => ({
  initPricingCache: () => undefined,
}));

const MANIFEST = JSON.stringify({
  $schema: AGENT_PLUGINS_SCHEMA_ID,
  name: "docs",
  version: "1.0.0",
  description: "Docs tools",
});

async function seed(): Promise<FakeApp> {
  const app = new FakeApp();
  await app.vault.createFolder(".agentic-plugins");
  return app;
}

function settings(overrides: Partial<AgenticChatSettings> = {}): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    plugins: { ...DEFAULT_SETTINGS.plugins, enabled: {}, mcpState: {}, sources: {} },
    mcp: { ...DEFAULT_SETTINGS.mcp, servers: [] },
    ...overrides,
  };
}

function serviceFor(app: FakeApp, current: AgenticChatSettings): PluginService {
  return new PluginService(app as unknown as App, () => current, () => undefined);
}

function startupPlugin(app: FakeApp): { plugin: AgenticChatPlugin; service: PluginService } {
  (app.vault as unknown as { on: () => void }).on = () => undefined;
  (app.workspace as unknown as { on: () => void }).on = () => undefined;
  (app as unknown as { secretStorage: unknown }).secretStorage = {
    getSecret: () => "",
    setSecret: () => undefined,
  };
  const PluginCtor = AgenticChatPlugin as unknown as new () => AgenticChatPlugin;
  const plugin = new PluginCtor();
  const target = plugin as unknown as Record<string, unknown>;
  target.app = app;
  target.manifest = { id: "agentic-chat", dir: ".obsidian/plugins/agentic-chat" };
  target.loadData = async () => null;
  target.saveData = async () => undefined;
  for (const method of [
    "registerView",
    "registerObsidianProtocolHandler",
    "addRibbonIcon",
    "addCommand",
    "addSettingTab",
    "registerEvent",
  ]) {
    target[method] = () => undefined;
  }
  const service = new PluginService(
    app as unknown as App,
    () => plugin.settings,
    () => plugin.saveSettings(),
  );
  service.ensureBuiltinsMaterialized = async () => false;
  service.ensureMySkillsMaterialized = async () => false;
  target.pluginService = service;
  return { plugin, service };
}

async function seedBackup(app: FakeApp): Promise<void> {
  await app.vault.createFolder(".agentic-plugins/.importing-backup-docs");
  await app.vault.create(".agentic-plugins/.importing-backup-docs/plugin.json", MANIFEST);
}

describe("post-216 plugin import sweep", () => {
  it("restores the backup when the target folder exists only in a stale tree", async () => {
    const app = await seed();
    await seedBackup(app);
    await app.vault.createFolder(".agentic-plugins/docs");
    app.vault.setAdapterExistsOverride(".agentic-plugins/docs", false);

    await serviceFor(app, settings()).reload();

    expect(app.vault.getAbstractFileByPath(".agentic-plugins/.importing-backup-docs")).toBeNull();
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/docs/plugin.json")).not.toBeNull();
  });

  it("uses adapter.stat instead of the vault tree to decide target existence", async () => {
    const root = new TFolder();
    root.path = ".agentic-plugins";
    root.name = ".agentic-plugins";
    const backup = new TFolder();
    backup.path = ".agentic-plugins/.importing-backup-docs";
    backup.name = ".importing-backup-docs";
    const staleTarget = new TFolder();
    staleTarget.path = ".agentic-plugins/docs";
    staleTarget.name = "docs";
    root.children = [backup, staleTarget];
    const renames: Array<[string, string]> = [];
    const removed: string[] = [];
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => (path === root.path ? root : undefined),
        adapter: {
          stat: async () => null,
          exists: async () => true,
          read: async () => {
            throw new Error("missing");
          },
          rename: async (from: string, to: string) => {
            renames.push([from, to]);
          },
          rmdir: async (path: string) => {
            removed.push(path);
          },
        },
      },
    } as unknown as App;

    await new PluginService(app, () => settings()).sweepImportStages();

    expect(renames).toEqual([[backup.path, ".agentic-plugins/docs"]]);
    expect(removed).not.toContain(backup.path);
  });

  it("replaces an empty target folder with the backup", async () => {
    const app = await seed();
    await seedBackup(app);
    await app.vault.createFolder(".agentic-plugins/docs");

    await serviceFor(app, settings()).sweepImportStages();

    expect(app.vault.getAbstractFileByPath(".agentic-plugins/.importing-backup-docs")).toBeNull();
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/docs/plugin.json")).not.toBeNull();
  });

  it("keeps a retained backup and its MCP state when the target is not a package", async () => {
    const app = await seed();
    await seedBackup(app);
    await app.vault.createFolder(".agentic-plugins/docs");
    await app.vault.create(".agentic-plugins/docs/notes.md", "user data");
    const current = settings();
    const id = pluginMcpServerId("docs", "docs");
    current.plugins.mcpState[id] = createMcpServerState(id, {
      enabled: true,
      lastUrl: "https://docs.example.com/mcp",
    });

    await serviceFor(app, current).reload();

    expect(app.vault.getAbstractFileByPath(".agentic-plugins/.importing-backup-docs")).not.toBeNull();
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/docs/notes.md")).not.toBeNull();
    expect(current.plugins.mcpState[id]).toBeDefined();
  });

  it("keeps stale MCP state while a retained backup exists and prunes it after removal", async () => {
    const app = await seed();
    await seedBackup(app);
    await app.vault.createFolder(".agentic-plugins/docs");
    await app.vault.create(".agentic-plugins/docs/notes.md", "user data");
    const current = settings();
    const id = pluginMcpServerId("docs", "docs");
    current.plugins.mcpState[id] = createMcpServerState(id, {
      enabled: true,
      lastUrl: "https://docs.example.com/mcp",
    });
    const service = serviceFor(app, current);
    const plugin = {
      settings: current,
      saveSettings: async () => undefined,
      pluginService: service,
    } as unknown as AgenticChatPlugin;
    const tab = new AgenticChatSettingTab(app as unknown as App, plugin);
    const reconcile = (tab as unknown as {
      reconcileLoadedPlugins: (plugins: unknown[]) => boolean;
    }).reconcileLoadedPlugins.bind(tab);

    await service.sweepImportStages();
    reconcile([]);

    expect(current.plugins.mcpState[id]).toBeDefined();
    expect(service.hasRetainedImportBackup()).toBe(true);

    await app.vault.adapter.rmdir(".agentic-plugins/.importing-backup-docs", true);
    await service.reload();

    expect(current.plugins.mcpState[id]).toBeUndefined();
  });

  it("continues the sweep when one stage child fails", async () => {
    const app = await seed();
    await seedBackup(app);
    await app.vault.createFolder(".agentic-plugins/.importing-temp");
    app.vault.setRmdirError(".agentic-plugins/.importing-temp", { code: "EIO", message: "I/O error" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const plugins = await serviceFor(app, settings()).reload();
      expect(plugins.map((plugin) => plugin.name)).toContain("docs");
      expect(app.vault.getAbstractFileByPath(".agentic-plugins/.importing-backup-docs")).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("runs the import sweep during plugin startup", async () => {
    const app = await seed();
    await seedBackup(app);
    const { plugin } = startupPlugin(app);

    await plugin.onload();

    expect(app.vault.getAbstractFileByPath(".agentic-plugins/docs/plugin.json")).not.toBeNull();
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/.importing-backup-docs")).toBeNull();
  });

  it("marks a retained backup during plugin startup", async () => {
    const app = await seed();
    await seedBackup(app);
    await app.vault.createFolder(".agentic-plugins/docs");
    await app.vault.create(".agentic-plugins/docs/notes.md", "user data");
    const { plugin, service } = startupPlugin(app);

    await plugin.onload();

    expect(service.hasRetainedImportBackup()).toBe(true);
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/.importing-backup-docs")).not.toBeNull();
  });
});
