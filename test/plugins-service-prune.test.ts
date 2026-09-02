import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { mergeSettings } from "../src/settings-schema";
import { PluginService } from "../src/plugins/service";
import { pluginMcpServerId } from "../src/plugins/loader";
import { FakeApp, FakeVault } from "./helpers/fake-vault";

function settings(overrides: Partial<AgenticChatSettings> = {}): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    plugins: { ...DEFAULT_SETTINGS.plugins, enabled: {}, sources: {}, mcpState: {} },
    mcp: { ...DEFAULT_SETTINGS.mcp, servers: [] },
    approval: { ...DEFAULT_SETTINGS.approval, perTool: {} },
    ...overrides,
  };
}
function svcFor(app: App, current: AgenticChatSettings, onSave?: () => void | Promise<void>) {
  return new PluginService(app, () => current, onSave);
}
async function seed(): Promise<{ app: App; vault: FakeVault; current: AgenticChatSettings; service: PluginService }> {
  const app = new FakeApp();
  await app.vault.createFolder(".agentic-plugins");
  const current = settings();
  const service = svcFor(app as unknown as App, current);
  return { app: app as unknown as App, vault: app.vault, current, service };
}

describe("PluginService.removeFolder dot-folder guard (issue #133)", () => {
  it("deletes a plugin whose folder is on disk but not in vault tree (dot-folder indexed gap)", async () => {
    const { app, vault, service } = await seed();
    await service.scaffoldSkill({ name: "alpha", description: "d", body: "# x" });
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/alpha")).not.toBeNull();
    vault.hideFolderFromTree(".agentic-plugins/alpha");
    expect(app.vault.getAbstractFileByPath(".agentic-plugins/alpha")).toBeNull();
    expect(await app.vault.adapter.exists(".agentic-plugins/alpha")).toBe(true);

    const existed = await service.removePackage("alpha", ".agentic-plugins/alpha");
    expect(existed).toBe(true);
    expect(await app.vault.adapter.exists(".agentic-plugins/alpha")).toBe(false);
  });

  it("returns false and still prunes settings when folder already absent (externally deleted)", async () => {
    const { app, current, service } = await seed();
    await service.scaffoldSkill({ name: "beta", description: "d", body: "# x" });
    // Simulate external delete before Remove
    await (app as unknown as { vault: FakeVault }).vault.adapter.rmdir(".agentic-plugins/beta", true);
    expect(await app.vault.adapter.exists(".agentic-plugins/beta")).toBe(false);
    // Seed settings entries to verify prune happens even when folder absent
    current.plugins.sources["beta"] = "manual";
    current.plugins.enabled["beta"] = false;
    const existed = await service.removePackage("beta", ".agentic-plugins/beta");
    expect(existed).toBe(false);
    expect(current.plugins.sources["beta"]).toBeUndefined();
    expect(current.plugins.enabled["beta"]).toBeUndefined();
  });

  it("swallows ENOENT from adapter.rmdir and returns false", async () => {
    const { vault, service } = await seed();
    await service.scaffoldSkill({ name: "gamma", description: "d", body: "# x" });
    vault.hideFolderFromTree(".agentic-plugins/gamma");
    vault.setRmdirError(".agentic-plugins/gamma", { code: "ENOENT", message: "ENOENT: no such file" });
    const existed = await service.removePackage("gamma", ".agentic-plugins/gamma");
    expect(existed).toBe(false);
    await service.scaffoldSkill({ name: "delta", description: "d", body: "# x" });
    vault.hideFolderFromTree(".agentic-plugins/delta");
    vault.setRmdirError(".agentic-plugins/delta", { code: "EACCES", message: "permission denied" });
    await expect(service.removePackage("delta", ".agentic-plugins/delta")).rejects.toThrow(/permission/);
  });

  it("blocks path traversal outside plugins folder", async () => {
    const { service } = await seed();
    // Attempt to delete outside — should not delete and return false, not throw
    const existed = await service.removePackage("evil", "../evil");
    expect(existed).toBe(false);
    const existed2 = await service.removePackage("evil", ".agentic-plugins");
    expect(existed2).toBe(false);
    const existed3 = await service.removePackage("evil", ".agentic-plugins/evil/../../.obsidian");
    expect(existed3).toBe(false);
    const existed4 = await service.removePackage("evil", "");
    expect(existed4).toBe(false);
  });

  it("removePackage prunes mcpState and perTool even on cache miss by reading mcp.json", async () => {
    const { app, vault, current, service } = await seed();
    // Create a package with mcp.json manually on disk without going through cache
    await vault.createFolder(".agentic-plugins/cache-miss-pkg");
    await app.vault.create(".agentic-plugins/cache-miss-pkg/plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "cache-miss-pkg", version: "1.0.0" }));
    await app.vault.create(".agentic-plugins/cache-miss-pkg/mcp.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { files: { type: "streamable-http", url: "https://mcp.example.com/mcp" }, extra: { type: "streamable-http", url: "https://extra.example.com/mcp" } } }));
    // Poison settings with derived ids + perTool before cache miss
    const id1 = pluginMcpServerId("cache-miss-pkg", "files");
    const id2 = pluginMcpServerId("cache-miss-pkg", "extra");
    current.plugins.mcpState[id1] = { id: id1, enabled: true, approval: "ask", authType: "none", authHeaderName: "", authHeaderValue: "", authHeaderValueSecretId: "", oauth: { clientId: "", clientSecret: "", clientSecretSecretId: "", authorizationEndpoint: "", tokenEndpoint: "", redirectUri: "", scope: "", accessToken: "", accessTokenSecretId: "", refreshToken: "", refreshTokenSecretId: "", expiresAt: 0, dynamicClientRegistration: false, registeredRedirectUri: "" }, knownTools: [], enabledTools: [], disabledTools: [], lastUrl: "https://mcp.example.com/mcp" } as unknown as typeof current.plugins.mcpState[string];
    current.plugins.mcpState[id2] = { id: id2, enabled: true, approval: "ask", authType: "none", authHeaderName: "", authHeaderValue: "", authHeaderValueSecretId: "", oauth: { clientId: "", clientSecret: "", clientSecretSecretId: "", authorizationEndpoint: "", tokenEndpoint: "", redirectUri: "", scope: "", accessToken: "", accessTokenSecretId: "", refreshToken: "", refreshTokenSecretId: "", expiresAt: 0, dynamicClientRegistration: false, registeredRedirectUri: "" }, knownTools: [], enabledTools: [], disabledTools: [], lastUrl: "https://extra.example.com/mcp" } as unknown as typeof current.plugins.mcpState[string];
    current.plugins.sources["cache-miss-pkg"] = "github:example/pkg";
    current.plugins.enabled["cache-miss-pkg"] = false;
    current.approval.perTool[`mcp__${id1}__tool_a`] = "allow";
    current.approval.perTool[`mcp__${id2}__tool_b`] = "allow";
    current.approval.perTool["write"] = "allow";
    // Ensure cache is empty (never loaded) to force cache-miss branch
    service.invalidate();
    // Call removePackage with cache miss
    const existed = await service.removePackage("cache-miss-pkg", ".agentic-plugins/cache-miss-pkg");
    expect(existed).toBe(true);
    expect(current.plugins.mcpState[id1]).toBeUndefined();
    expect(current.plugins.mcpState[id2]).toBeUndefined();
    expect(current.approval.perTool[`mcp__${id1}__tool_a`]).toBeUndefined();
    expect(current.approval.perTool[`mcp__${id2}__tool_b`]).toBeUndefined();
    expect(current.approval.perTool["write"]).toBe("allow");
    expect(current.plugins.sources["cache-miss-pkg"]).toBeUndefined();
    expect(current.plugins.enabled["cache-miss-pkg"]).toBeUndefined();
  });

  it("cache lookup prefers rootPath over name to avoid wrong id pruning", async () => {
    const { app, current, service } = await seed();
    await service.scaffoldSkill({ name: "plugin-a", description: "d", body: "# a" });
    await service.scaffoldSkill({ name: "plugin-b", description: "d", body: "# b" });
    await service.reload();
    const idA = pluginMcpServerId("plugin-a", "srv");
    const idB = pluginMcpServerId("plugin-b", "srv");
    current.plugins.mcpState[idA] = { id: idA, enabled: true, approval: "ask", authType: "none", authHeaderName: "", authHeaderValue: "", authHeaderValueSecretId: "", oauth: { clientId: "", clientSecret: "", clientSecretSecretId: "", authorizationEndpoint: "", tokenEndpoint: "", redirectUri: "", scope: "", accessToken: "", accessTokenSecretId: "", refreshToken: "", refreshTokenSecretId: "", expiresAt: 0, dynamicClientRegistration: false, registeredRedirectUri: "" }, knownTools: [], enabledTools: [], disabledTools: [], lastUrl: "https://a.example.com" } as unknown as typeof current.plugins.mcpState[string];
    current.plugins.mcpState[idB] = { id: idB, enabled: true, approval: "ask", authType: "none", authHeaderName: "", authHeaderValue: "", authHeaderValueSecretId: "", oauth: { clientId: "", clientSecret: "", clientSecretSecretId: "", authorizationEndpoint: "", tokenEndpoint: "", redirectUri: "", scope: "", accessToken: "", accessTokenSecretId: "", refreshToken: "", refreshTokenSecretId: "", expiresAt: 0, dynamicClientRegistration: false, registeredRedirectUri: "" }, knownTools: [], enabledTools: [], disabledTools: [], lastUrl: "https://b.example.com" } as unknown as typeof current.plugins.mcpState[string];
    const cache = (service as unknown as { cache: unknown }).cache as Array<{ name: string; rootPath: string; mcpServers: Array<{ id: string }> }>;
    expect(cache.length).toBeGreaterThanOrEqual(2);
    cache.find((p) => p.name === "plugin-a");
    cache.find((p) => p.name === "plugin-b");
    await service.removePackage("plugin-b", ".agentic-plugins/plugin-a");
    expect(current.plugins.mcpState[idB]).toBeDefined();
    expect(await app.vault.adapter.exists(".agentic-plugins/plugin-a")).toBe(false);
    expect(await app.vault.adapter.exists(".agentic-plugins/plugin-b")).toBe(true);
  });
});

describe("PluginService.reload orphan pruning", () => {
  it("prunes orphan enabled/sources/mcpState/perTool and legacy mcp.servers on reload", async () => {
    const { app, current, service } = await seed();
    await service.scaffoldSkill({ name: "keep", description: "d", body: "# k" });
    await service.reload();
    // Simulate plugin previously installed but now deleted externally
    const orphanId = pluginMcpServerId("orphan", "files");
    current.plugins.mcpState[orphanId] = { id: orphanId, enabled: true, approval: "ask", authType: "none", authHeaderName: "", authHeaderValue: "", authHeaderValueSecretId: "", oauth: { clientId: "", clientSecret: "", clientSecretSecretId: "", authorizationEndpoint: "", tokenEndpoint: "", redirectUri: "", scope: "", accessToken: "", accessTokenSecretId: "", refreshToken: "", refreshTokenSecretId: "", expiresAt: 0, dynamicClientRegistration: false, registeredRedirectUri: "" }, knownTools: [], enabledTools: [], disabledTools: [], lastUrl: "https://orphan.example.com" } as unknown as typeof current.plugins.mcpState[string];
    current.plugins.enabled["orphan"] = false;
    current.plugins.sources["orphan"] = "github:example/orphan";
    current.approval.perTool[`mcp__${orphanId}__tool_x`] = "allow";
    current.approval.perTool["write"] = "allow";
    current.mcp.servers.push({ id: orphanId, name: "orphan: files", url: "https://orphan.example.com/mcp", enabled: true, approval: "ask", authType: "none", authHeaderName: "", authHeaderValue: "", authHeaderValueSecretId: "", oauth: { clientId: "", clientSecret: "", clientSecretSecretId: "", authorizationEndpoint: "", tokenEndpoint: "", redirectUri: "", scope: "", accessToken: "", accessTokenSecretId: "", refreshToken: "", refreshTokenSecretId: "", expiresAt: 0, dynamicClientRegistration: false, registeredRedirectUri: "" }, knownTools: [], enabledTools: [], disabledTools: [], headers: {}, source: "plugin", pluginRoot: ".agentic-plugins/orphan" } as unknown as typeof current.mcp.servers[number]);
    let saveCalls = 0;
    const savingService = svcFor(app, current, () => { saveCalls += 1; });
    await savingService.reload();
    expect(current.plugins.mcpState[orphanId]).toBeUndefined();
    expect(current.plugins.enabled["orphan"]).toBeUndefined();
    expect(current.plugins.sources["orphan"]).toBeUndefined();
    expect(current.approval.perTool[`mcp__${orphanId}__tool_x`]).toBeUndefined();
    expect(current.approval.perTool["write"]).toBe("allow");
    expect(current.mcp.servers.find((s) => s.pluginRoot === ".agentic-plugins/orphan")).toBeUndefined();
    expect(saveCalls).toBe(1);
  });

  it("does not prune mcpState for ids that are legacy user servers (isLegacyUser guard)", async () => {
    const { current, service } = await seed();
    await service.scaffoldSkill({ name: "keep2", description: "d", body: "# k" });
    const legacyId = "legacy-user-id";
    current.plugins.mcpState[legacyId] = { id: legacyId, enabled: true, approval: "ask", authType: "none", authHeaderName: "", authHeaderValue: "", authHeaderValueSecretId: "", oauth: { clientId: "", clientSecret: "", clientSecretSecretId: "", authorizationEndpoint: "", tokenEndpoint: "", redirectUri: "", scope: "", accessToken: "", accessTokenSecretId: "", refreshToken: "", refreshTokenSecretId: "", expiresAt: 0, dynamicClientRegistration: false, registeredRedirectUri: "" }, knownTools: [], enabledTools: [], disabledTools: [], lastUrl: "https://legacy.example.com" } as unknown as typeof current.plugins.mcpState[string];
    current.mcp.servers.push({ id: legacyId, name: "legacy", url: "https://legacy.example.com/mcp", enabled: true, approval: "ask", authType: "none", authHeaderName: "", authHeaderValue: "", authHeaderValueSecretId: "", oauth: { clientId: "", clientSecret: "", clientSecretSecretId: "", authorizationEndpoint: "", tokenEndpoint: "", redirectUri: "", scope: "", accessToken: "", accessTokenSecretId: "", refreshToken: "", refreshTokenSecretId: "", expiresAt: 0, dynamicClientRegistration: false, registeredRedirectUri: "" }, knownTools: [], enabledTools: [], disabledTools: [], headers: {}, source: "user" } as unknown as typeof current.mcp.servers[number]);
    await service.reload();
    expect(current.plugins.mcpState[legacyId]).toBeDefined();
  });

  it("listExternallyDeletedPlugins returns plugins whose adapter.exists is false", async () => {
    const { app, service } = await seed();
    await service.scaffoldSkill({ name: "to-delete", description: "d", body: "# x" });
    await service.reload();
    expect(await service.listExternallyDeletedPlugins()).toHaveLength(0);
    await app.vault.adapter.rmdir(".agentic-plugins/to-delete", true);
    expect(await service.listExternallyDeletedPlugins()).toHaveLength(1);
    expect((await service.listExternallyDeletedPlugins())[0].name).toBe("to-delete");
  });

  it("loadPlugins merges adapter-discovered dot-folders not in tree", async () => {
    const { vault, service } = await seed();
    await service.scaffoldSkill({ name: "visible", description: "d", body: "# v" });
    vault.hideFolderFromTree(".agentic-plugins/visible");
    vault.addDiskOnlyFolder(".agentic-plugins/hidden-pkg");
    vault.addDiskOnlyFile(".agentic-plugins/hidden-pkg/plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "hidden-pkg", version: "1.0.0" }));
    vault.addDiskOnlyFile(".agentic-plugins/hidden-pkg/skills/hidden-pkg/SKILL.md", "---\nname: hidden-pkg\ndescription: H\n---\nBody");
    const plugins = await service.reload();
    const names = plugins.map((p) => p.name).sort();
    expect(names).toContain("hidden-pkg");
    expect(names).toContain("visible");
  });
});

describe("healPluginsFolder security", () => {
  it("falls back to default for traversal / absolute / colon / backslash", () => {
    expect(mergeSettings({ plugins: { folder: "../evil" } as never }).plugins.folder).toBe(".agentic-plugins");
    expect(mergeSettings({ plugins: { folder: "/absolute" } as never }).plugins.folder).toBe(".agentic-plugins");
    expect(mergeSettings({ plugins: { folder: "a/b/../../c" } as never }).plugins.folder).toBe(".agentic-plugins");
    expect(mergeSettings({ plugins: { folder: "C:\\Windows" } as never }).plugins.folder).toBe(".agentic-plugins");
    expect(mergeSettings({ plugins: { folder: "https://evil.com" } as never }).plugins.folder).toBe(".agentic-plugins");
    expect(mergeSettings({ plugins: { folder: "" } as never }).plugins.folder).toBe(".agentic-plugins");
    expect(mergeSettings({ plugins: { folder: ".agentic-plugins" } as never }).plugins.folder).toBe(".agentic-plugins");
    expect(mergeSettings({ plugins: { folder: "my-plugins" } as never }).plugins.folder).toBe("my-plugins");
    expect(mergeSettings({ plugins: { folder: "a/b/c" } as never }).plugins.folder).toBe("a/b/c");
  });
});
