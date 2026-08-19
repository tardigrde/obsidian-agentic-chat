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
    // The fatal message must surface exactly once in the reports.
    expect(plugins[0]?.reports.filter((report) => report.message.includes("plugin.json is missing"))).toHaveLength(1);
  });

  it("never loads .importing-* stage folders as real plugins", async () => {
    const app = await seed();
    await addPlugin(app, "real", { "plugin.json": manifest("real") });
    await addPlugin(app, ".importing-backup-real", { "plugin.json": manifest("real") });
    const plugins = await loadPlugins(app);
    expect(plugins.map((plugin) => plugin.name)).toEqual(["real"]);
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

  it("loads Unicode skill names and matches the directory after NFKC", async () => {
    const app = await seed();
    await addPlugin(app, "tools", {
      "plugin.json": manifest("tools"),
      "skills/分析/SKILL.md": "---\nname: 分析\ndescription: 分析笔记\n---\n分析。",
      "skills/ｓｕｍ/SKILL.md": "---\nname: sum\ndescription: Sum things\n---\nSum.",
    });
    const skills = byName(await loadPlugins(app), "tools").skills;
    expect(skills.map((skill) => skill.name).sort()).toEqual(["sum", "分析"]);
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

  it("accepts a frontmatter-only skill (empty body is valid)", async () => {
    const app = await seed();
    await addPlugin(app, "tools", {
      "plugin.json": manifest("tools"),
      "skills/minimal/SKILL.md": "---\nname: minimal\ndescription: Does nothing yet\n---\n",
    });
    const plugin = byName(await loadPlugins(app), "tools");
    expect(plugin.auditStatus).toBe("ok");
    expect(plugin.skills.map((skill) => skill.name)).toEqual(["minimal"]);
    expect(plugin.skills[0]?.content).toBe("");
  });

  it("skips a skill missing a name and stays partial", async () => {
    const app = await seed();
    await addPlugin(app, "tools", {
      "plugin.json": manifest("tools"),
      "skills/noname/SKILL.md": "---\ndescription: No name here\n---\nBody.",
    });
    const plugin = byName(await loadPlugins(app), "tools");
    expect(plugin.auditStatus).toBe("partial");
    expect(plugin.skillReports[0]?.message).toMatch(/"name" frontmatter/);
  });

  it("skips a skill whose name does not match its directory", async () => {
    const app = await seed();
    await addPlugin(app, "tools", {
      "plugin.json": manifest("tools"),
      "skills/mismatch/SKILL.md": "---\nname: other-name\ndescription: Mismatched\n---\nBody.",
    });
    const plugin = byName(await loadPlugins(app), "tools");
    expect(plugin.auditStatus).toBe("partial");
    expect(plugin.skillReports[0]?.message).toMatch(/must match the skill directory name/);
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
      "skills/one/SKILL.md": "---\nname: one\ndescription: First skill\n---\nBody.",
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

  it("falls back to the adapter when the vault tree misses the plugins folder", async () => {
    const app = new FakeApp() as unknown as App;
    (app.vault as unknown as { adapter: { list: (p: string) => Promise<{ folders: string[]; files: string[] }>; read: (p: string) => Promise<string> } }).adapter = {
      list: async (path: string) => {
        if (path === ".agentic-plugins") return { folders: [".agentic-plugins/disk-only"], files: [] };
        if (path === ".agentic-plugins/disk-only/skills") return { folders: [".agentic-plugins/disk-only/skills/summarize"], files: [] };
        return { folders: [], files: [] };
      },
      read: async (path: string) => {
        const files: Record<string, string> = {
          ".agentic-plugins/disk-only/plugin.json": manifest("disk-only"),
          ".agentic-plugins/disk-only/mcp.json": mcpDoc({
            api: { type: "streamable-http", url: "https://disk.example/mcp" },
          }),
          ".agentic-plugins/disk-only/skills/summarize/SKILL.md":
            "---\nname: summarize\ndescription: Summarize\n---\nBody.",
        };
        if (!(path in files)) throw new Error(`no such file: ${path}`);
        return files[path] ?? "";
      },
    };
    const plugins = await loadPlugins(app);
    const plugin = byName(plugins, "disk-only");
    expect(plugin.auditStatus).toBe("ok");
    expect(plugin.skills.map((skill) => skill.name)).toEqual(["summarize"]);
    expect(plugin.mcpServers.map((server) => server.id)).toEqual([pluginMcpServerId("disk-only", "api")]);
  });

  it("honors the per-plugin enable map", async () => {
    const app = await seed();
    await addPlugin(app, "on", { "plugin.json": manifest("on") });
    await addPlugin(app, "off", { "plugin.json": manifest("off") });
    const plugins = await loadPlugins(app, { enabledPlugins: { off: false } });
    expect(byName(plugins, "on").enabled).toBe(true);
    expect(byName(plugins, "off").enabled).toBe(false);
  });

  it("marks a plugin partial when mcp.json is a folder", async () => {
    const app = await seed();
    await addPlugin(app, "weird", { "plugin.json": manifest("weird") });
    await app.vault.createFolder(".agentic-plugins/weird/mcp.json");
    const plugin = byName(await loadPlugins(app), "weird");
    expect(plugin.auditStatus).toBe("partial");
    expect(plugin.reports.some((report) => report.message.includes("mcp.json"))).toBe(true);
  });

  it("stays ok with an empty mcpServers object (valid absence)", async () => {
    const app = await seed();
    await addPlugin(app, "bare", {
      "plugin.json": manifest("bare"),
      "mcp.json": JSON.stringify({ $schema: AGENT_PLUGINS_MCP_SCHEMA_ID, mcpServers: {} }),
    });
    const plugin = byName(await loadPlugins(app), "bare");
    expect(plugin.auditStatus).toBe("ok");
    expect(plugin.mcpServers).toEqual([]);
  });

  it("marks a plugin partial when a server entry is invalid", async () => {
    const app = await seed();
    await addPlugin(app, "broken", {
      "plugin.json": manifest("broken"),
      "mcp.json": mcpDoc({ api: { type: "streamable-http", url: "not-a-url" } }),
    });
    const plugin = byName(await loadPlugins(app), "broken");
    expect(plugin.auditStatus).toBe("partial");
    expect(plugin.mcpServers).toEqual([]);
  });
});

describe("mergePluginMcpServers / syncMcpServers", () => {
  it("preserves persisted client-owned state by stable id", () => {
    const derived = [
      {
        ...createMcpServerSettings({ id: pluginMcpServerId("corp", "deployment-api"), name: "corp: deployment-api", url: "https://a.example/mcp" }),
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

  it("drops persisted plugin records for servers no plugin declares", () => {
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

  it("preserves user-configured servers alongside derived plugin servers", () => {
    const userServer = {
      ...createMcpServerSettings({ id: "my-user-server", name: "User", url: "https://user.example/mcp" }),
      source: "user" as const,
      headers: {},
    };
    const derived = [
      {
        ...createMcpServerSettings({ id: pluginMcpServerId("corp", "api"), name: "corp: api", url: "https://a.example/mcp" }),
        source: "plugin" as const,
        pluginRoot: ".agentic-plugins/corp",
        headers: {},
      },
    ];
    const persisted = [
      { ...userServer },
      { ...derived[0], enabled: false },
      {
        ...createMcpServerSettings({ id: "orphan-plugin", name: "Orphan", url: "https://orphan.example/mcp" }),
        source: "plugin" as const,
        headers: {},
      },
    ];
    const merged = mergePluginMcpServers(persisted, derived);
    expect(merged.map((server) => server.id)).toEqual(["my_user_server", derived[0].id]);
    expect(merged[0]).toMatchObject({ source: "user", url: "https://user.example/mcp" });
    expect(merged[1]).toMatchObject({ enabled: false, source: "plugin" });
  });

  it("keeps user servers even when there are no plugin servers", () => {
    const userServer = {
      ...createMcpServerSettings({ id: "my-user-server", name: "User", url: "https://user.example/mcp" }),
      source: "user" as const,
      headers: {},
    };
    const merged = mergePluginMcpServers([{ ...userServer }], []);
    expect(merged.map((server) => server.id)).toEqual(["my_user_server"]);
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

  it("returns matched persisted records by identity so runtime mutations persist", () => {
    const persisted = [
      {
        ...createMcpServerSettings({ id: "plugin_a_b", name: "a: b", url: "https://a.example/mcp" }),
        source: "plugin" as const,
        headers: {},
        oauth: {
          ...createMcpServerSettings().oauth,
          accessToken: "",
          refreshToken: "r0",
          expiresAt: 0,
        },
      },
    ];
    const derived = [
      {
        ...createMcpServerSettings({ id: "plugin_a_b", name: "a: b", url: "https://b.example/mcp" }),
        source: "plugin" as const,
        headers: { "X-Tenant": "v2" },
      },
    ];
    const merged = mergePluginMcpServers(persisted, derived);
    expect(merged[0]).toBe(persisted[0]);
    expect(merged[0]?.url).toBe("https://b.example/mcp");
    expect(merged[0]?.headers).toEqual({ "X-Tenant": "v2" });

    // The runtime reassigns `oauth` in place during token refreshes; the
    // persisted record must observe it (same object identity).
    merged[0].oauth = { ...merged[0].oauth, accessToken: "fresh", refreshToken: "r1", expiresAt: 1234 };
    expect(persisted[0].oauth.accessToken).toBe("fresh");
  });

  it("clears client-owned auth state when a plugin moves a server URL", () => {
    const id = pluginMcpServerId("corp", "api");
    const persisted = [
      {
        ...createMcpServerSettings({ id, name: "corp: api", url: "https://a.example/mcp" }),
        source: "plugin" as const,
        headers: {},
        oauth: {
          ...createMcpServerSettings().oauth,
          accessToken: "tok-a",
          refreshToken: "refresh-a",
          expiresAt: 1234,
        },
        authHeaderValue: "secret-a",
      },
    ];
    const derived = [
      {
        ...createMcpServerSettings({ id, name: "corp: api", url: "https://b.example/mcp" }),
        source: "plugin" as const,
        headers: {},
      },
    ];
    const merged = mergePluginMcpServers(persisted, derived);
    expect(merged[0]?.url).toBe("https://b.example/mcp");
    expect(merged[0]?.oauth.accessToken).toBe("");
    expect(merged[0]?.oauth.refreshToken).toBe("");
    expect(merged[0]?.authHeaderValue).toBe("");
  });

  it("distinguishes plugin id pairs whose slugs collide", () => {
    expect(pluginMcpServerId("a", "b_c")).not.toBe(pluginMcpServerId("a_b", "c"));
    expect(pluginMcpServerId("acme", "docs-api")).not.toBe(pluginMcpServerId("acme-docs", "api"));
    const long = "x".repeat(30);
    expect(pluginMcpServerId(long, "a")).not.toBe(pluginMcpServerId(long, "b"));
    expect(pluginMcpServerId("docs", "docs")).toBe("plugin_docs_docs_889dfa93cd1a");
  });
});