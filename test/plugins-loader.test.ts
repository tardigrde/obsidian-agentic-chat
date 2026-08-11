import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import {
  loadPlugins,
  mergePluginMcpServers,
  pluginMcpServerId,
  syncMcpServers,
  type LoadedPlugin,
} from "../src/plugins/loader";
import { AGENT_PLUGINS_MCP_SCHEMA_ID, AGENT_PLUGINS_SCHEMA_ID } from "../src/plugins/manifest";
import { FakeApp } from "./helpers/fake-vault";
import { createMcpServerSettings } from "../src/mcp/settings";

function manifest(name: string): string {
  return JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_ID, name, version: "1.0.0", description: `${name} tools` });
}

function mcpDoc(servers: Record<string, unknown>): string {
  return JSON.stringify({ $schema: AGENT_PLUGINS_MCP_SCHEMA_ID, mcpServers: servers });
}

async function seed(): Promise<App> {
  const app = new FakeApp();
  await app.vault.createFolder(".agentic-plugins");
  return app as unknown as App;
}

async function addPlugin(app: App, name: string, files: Record<string, string>): Promise<void> {
  const base = `.agentic-plugins/${name}`;
  await app.vault.createFolder(base);
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/");
    let current = base;
    for (let index = 0; index < parts.length - 1; index += 1) {
      current += `/${parts[index]}`;
      if (!app.vault.getAbstractFileByPath(current)) {
        await app.vault.createFolder(current);
      }
    }
    await app.vault.create(`${base}/${path}`, content);
  }
}

function byName(plugins: LoadedPlugin[], name: string): LoadedPlugin {
  const plugin = plugins.find((item) => item.name === name);
  if (!plugin) throw new Error(`plugin ${name} not found`);
  return plugin;
}

describe("loadPlugins", () => {
  it("returns [] for a missing plugins folder", async () => {
    const app = new FakeApp() as unknown as App;
    expect(await loadPlugins(app)).toEqual([]);
  });

  it("rejects a plugin with a missing manifest", async () => {
    const app = await seed();
    await app.vault.createFolder(".agentic-plugins/empty");
    const plugins = await loadPlugins(app);
    expect(plugins[0]?.auditStatus).toBe("failed");
    expect(plugins[0]?.manifestProblem).toMatch(/plugin.json is missing/);
  });

  it("rejects a plugin with a fatal manifest violation and keeps others", async () => {
    const app = await seed();
    await addPlugin(app, "bad", { "plugin.json": JSON.stringify({ name: "Bad-Name" }) });
    await addPlugin(app, "good", { "plugin.json": manifest("good") });
    const plugins = await loadPlugins(app);
    expect(byName(plugins, "bad").auditStatus).toBe("failed");
    expect(byName(plugins, "bad").manifestProblem).toMatch(/\$schema/);
    expect(byName(plugins, "good").auditStatus).toBe("ok");
  });

  it("loads plugin skills from skills/<name>/SKILL.md", async () => {
    const app = await seed();
    await addPlugin(app, "tools", {
      "plugin.json": manifest("tools"),
      "skills/summarize/SKILL.md":
        "---\nname: summarize\ndescription: Summarize things\n---\nRead a note and summarize it.",
    });
    const plugins = await loadPlugins(app);
    const plugin = byName(plugins, "tools");
    expect(plugin.auditStatus).toBe("ok");
    expect(plugin.skills.map((skill) => skill.name)).toEqual(["summarize"]);
    expect(plugin.skills[0]?.content).toMatch(/summarize it/);
  });

  it("skips a skill directory without SKILL.md and stays partial", async () => {
    const app = await seed();
    await addPlugin(app, "tools", {
      "plugin.json": manifest("tools"),
      "skills/broken/notes.md": "no skill here",
    });
    const plugin = byName(await loadPlugins(app), "tools");
    expect(plugin.auditStatus).toBe("partial");
    expect(plugin.skillReports[0]?.message).toMatch(/SKILL.md is missing/);
  });

  it("skips a skill with empty body", async () => {
    const app = await seed();
    await addPlugin(app, "tools", {
      "plugin.json": manifest("tools"),
      "skills/empty/SKILL.md": "---\nname: empty\n---\n",
    });
    const plugin = byName(await loadPlugins(app), "tools");
    expect(plugin.auditStatus).toBe("partial");
    expect(plugin.skillReports[0]?.message).toMatch(/empty body/);
  });

  it("derives streamable-http MCP servers with stable ids", async () => {
    const app = await seed();
    await addPlugin(app, "corp", {
      "plugin.json": manifest("corp"),
      "mcp.json": mcpDoc({
        "deployment-api": { type: "streamable-http", url: "https://deploy.example.com/mcp" },
      }),
    });
    const plugin = byName(await loadPlugins(app), "corp");
    expect(plugin.auditStatus).toBe("ok");
    expect(plugin.mcpServers).toHaveLength(1);
    expect(plugin.mcpServers[0]).toMatchObject({
      id: pluginMcpServerId("corp", "deployment-api"),
      name: "corp: deployment-api",
      url: "https://deploy.example.com/mcp",
      source: "plugin",
      pluginRoot: ".agentic-plugins/corp",
      approval: "ask",
    });
  });

  it("skips stdio entries as unsupported and keeps streamable-http ones", async () => {
    const app = await seed();
    await addPlugin(app, "mixed", {
      "plugin.json": manifest("mixed"),
      "mcp.json": mcpDoc({
        local: { type: "stdio", command: "./bin/server" },
        remote: { type: "streamable-http", url: "https://ok.example/mcp" },
      }),
    });
    const plugin = byName(await loadPlugins(app), "mixed");
    expect(plugin.mcpServers.map((server) => server.id)).toEqual([pluginMcpServerId("mixed", "remote")]);
    expect(plugin.reports.some((report) => report.message.includes("stdio"))).toBe(true);
  });

  it("disables MCP for the plugin but keeps skills when mcp.json is invalid", async () => {
    const app = await seed();
    await addPlugin(app, "half", {
      "plugin.json": manifest("half"),
      "mcp.json": "{ not json",
      "skills/one/SKILL.md": "---\nname: one\n---\nBody.",
    });
    const plugin = byName(await loadPlugins(app), "half");
    expect(plugin.skills.map((skill) => skill.name)).toEqual(["one"]);
    expect(plugin.mcpServers).toEqual([]);
    expect(plugin.reports.some((report) => report.message.includes("mcp.json"))).toBe(true);
  });

  it("propagates plugin headers and mirrors them on derived servers", async () => {
    const app = await seed();
    await addPlugin(app, "hdrs", {
      "plugin.json": manifest("hdrs"),
      "mcp.json": mcpDoc({
        api: { type: "streamable-http", url: "https://api.example/mcp", headers: { "X-Tenant": "public" } },
      }),
    });
    expect(byName(await loadPlugins(app), "hdrs").mcpServers[0]?.headers).toEqual({ "X-Tenant": "public" });
  });

  it("honors the per-plugin enable map", async () => {
    const app = await seed();
    await addPlugin(app, "on", { "plugin.json": manifest("on") });
    await addPlugin(app, "off", { "plugin.json": manifest("off") });
    const plugins = await loadPlugins(app, { enabledPlugins: { off: false } });
    expect(byName(plugins, "on").enabled).toBe(true);
    expect(byName(plugins, "off").enabled).toBe(false);
  });
});

describe("mergePluginMcpServers / syncMcpServers", () => {
  it("preserves persisted client-owned state by stable id", () => {
    const derived = [
      {
        ...createMcpServerSettings({ id: "plugin_corp_deployment_api", name: "corp: deployment-api", url: "https://a.example/mcp" }),
        source: "plugin" as const,
        pluginRoot: ".agentic-plugins/corp",
        headers: {},
      },
    ];
    const persisted = [
      {
        ...derived[0],
        enabled: false,
        approval: "deny" as const,
        knownTools: [{ name: "deploy", title: "Deploy", readOnlyHint: false }],
      },
    ];
    const merged = mergePluginMcpServers(persisted, derived);
    expect(merged[0]).toMatchObject({ enabled: false, approval: "deny" });
    expect(merged[0]?.knownTools).toHaveLength(1);
  });

  it("drops persisted records for servers no plugin declares", () => {
    const derived = [
      {
        ...createMcpServerSettings({ id: "plugin_a_b", name: "a: b", url: "https://a.example/mcp" }),
        source: "plugin" as const,
        headers: {},
      },
    ];
    const persisted = [
      ...derived,
      {
        ...createMcpServerSettings({ id: "orphan", name: "Orphan", url: "https://orphan.example/mcp" }),
        source: "plugin" as const,
        headers: {},
      },
    ];
    expect(mergePluginMcpServers(persisted, derived).map((server) => server.id)).toEqual(["plugin_a_b"]);
  });

  it("retains user-sourced persisted servers alongside derived ones", () => {
    const derived = [
      {
        ...createMcpServerSettings({ id: "plugin_a_b", name: "a: b", url: "https://a.example/mcp" }),
        source: "plugin" as const,
        headers: {},
      },
    ];
    const persisted = [
      { ...createMcpServerSettings({ id: "user-keep", name: "Keep", url: "http://intranet.example/mcp" }), headers: {} },
      ...derived,
    ];
    const merged = mergePluginMcpServers(persisted, derived);
    expect(merged.map((server) => server.id)).toEqual(["user_keep", "plugin_a_b"]);
  });

  it("syncMcpServers writes the merged list back", () => {
    const settings = { mcp: { servers: [] as ReturnType<typeof createMcpServerSettings>[] } };
    const derived = [
      {
        ...createMcpServerSettings({ id: "plugin_a_b", name: "a: b", url: "https://a.example/mcp" }),
        source: "plugin" as const,
        headers: {},
      },
    ];
    syncMcpServers(settings, derived);
    expect(settings.mcp.servers).toHaveLength(1);
  });
});