import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
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
