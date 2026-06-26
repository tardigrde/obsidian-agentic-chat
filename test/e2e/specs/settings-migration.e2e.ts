import { $, browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const PLUGIN_ID = "agentic-chat";
const SECRET_IDS = {
  openrouter: "agentic-chat-openrouter-api-key",
  openaiCompatible: "agentic-chat-openai-compatible-api-key",
  webSearch: "agentic-chat-web-search-api-key",
  mcpAuth: "agentic-chat-mcp-docs-auth-header-value",
  mcpClientSecret: "agentic-chat-mcp-docs-oauth-client-secret",
  mcpAccessToken: "agentic-chat-mcp-docs-oauth-access-token",
  mcpRefreshToken: "agentic-chat-mcp-docs-oauth-refresh-token",
} as const;

const LEGACY_SETTINGS = {
  provider: "openai-compatible",
  openrouterApiKey: "legacy-openrouter-key",
  openaiCompatibleBaseUrl: "https://legacy-gateway.example/api",
  openaiCompatibleApiKey: "legacy-openai-compatible-key",
  openaiCompatibleModel: "legacy/model",
  mode: "retired-mode",
  approval: {
    mutating: "ask",
    perTool: { write: "allow" },
    workingDirs: "Notes",
  },
  web: {
    enabled: true,
    searchProvider: "searxng",
    searchApiKey: "legacy-web-key",
    searxngUrl: "https://search.example.com",
    maxResults: 8,
    fetchCharLimit: 15_000,
  },
  mcp: {
    enabled: true,
    proxyUrl: "http://proxy.example.com:8080/",
    noProxy: "LOCALHOST, localhost, *.example.com",
    servers: [
      {
        id: "docs",
        name: "Docs MCP",
        url: "https://docs.example.com/mcp",
        enabled: true,
        authType: "bearer",
        authHeaderValue: "legacy-mcp-token",
        approval: "allow",
        knownTools: [{ name: "search", title: "Search docs", readOnlyHint: true }],
        oauth: {
          clientId: "legacy-client",
          clientSecret: "legacy-client-secret",
          accessToken: "legacy-access-token",
          refreshToken: "legacy-refresh-token",
          expiresAt: 123,
          scope: "docs.read",
        },
      },
    ],
  },
};

interface MigrationState {
  settings: {
    provider: string;
    openrouterApiKey: string;
    openaiCompatibleBaseUrl: string;
    openaiCompatibleApiKey: string;
    openaiCompatibleModel: string;
    mode: string;
    approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
    web: { enabled: boolean; searchProvider: string; searchApiKey: string; searxngUrl: string; maxResults: number; fetchCharLimit: number };
    mcp: {
      enabled: boolean;
      proxyUrl: string;
      noProxy: string;
      servers: Array<{
        id: string;
        name: string;
        url: string;
        authType: string;
        authHeaderValueSecretId: string;
        authHeaderValue: string;
        approval: string;
        knownTools: Array<{ name: string; localName?: string; title: string; readOnlyHint: boolean }>;
        oauth: {
          clientId: string;
          clientSecretSecretId: string;
          clientSecret: string;
          accessTokenSecretId: string;
          accessToken: string;
          refreshTokenSecretId: string;
          refreshToken: string;
          expiresAt: number;
          scope: string;
        };
      }>;
    };
  };
  stored: Record<string, unknown>;
  secrets: Record<string, string>;
}

async function installLegacyDataAndReloadPlugin(): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, payload) => {
      const pluginApi = (app as unknown as {
        plugins?: {
          disablePluginAndSave?: (id: string) => Promise<void>;
          enablePluginAndSave?: (id: string) => Promise<void>;
        };
        secretStorage?: { setSecret?: (id: string, value: string) => void };
      }).plugins;
      if (!pluginApi?.disablePluginAndSave || !pluginApi.enablePluginAndSave) {
        throw new Error("Obsidian plugin API not available");
      }

      await pluginApi.disablePluginAndSave(payload.pluginId);
      for (const id of payload.secretIds) app.secretStorage?.setSecret?.(id, "");

      const pluginDir = `${app.vault.configDir}/plugins/${payload.pluginId}`;
      if (!(await app.vault.adapter.exists(pluginDir))) await app.vault.adapter.mkdir(pluginDir);
      await app.vault.adapter.write(`${pluginDir}/data.json`, payload.dataJson);
      await pluginApi.enablePluginAndSave(payload.pluginId);
    },
    {
      pluginId: PLUGIN_ID,
      secretIds: Object.values(SECRET_IDS),
      dataJson: JSON.stringify(LEGACY_SETTINGS, null, 2),
    },
  );
}

async function readMigrationState(): Promise<MigrationState> {
  return await browser.executeObsidian(
    async ({ app }, payload) => {
      const plugin = (app as unknown as {
        plugins?: { plugins?: Record<string, { settings?: unknown }> };
        secretStorage?: { getSecret?: (id: string) => string | null | undefined };
      }).plugins?.plugins?.[payload.pluginId];
      if (!plugin) throw new Error("agentic-chat plugin not found after reload");

      const storedRaw = await app.vault.adapter.read(`${app.vault.configDir}/plugins/${payload.pluginId}/data.json`);
      const secrets = Object.fromEntries(
        payload.secretIds.map((id) => [id, app.secretStorage?.getSecret?.(id) ?? ""]),
      );
      return {
        settings: JSON.parse(JSON.stringify(plugin.settings)),
        stored: JSON.parse(storedRaw) as Record<string, unknown>,
        secrets,
      } satisfies MigrationState;
    },
    { pluginId: PLUGIN_ID, secretIds: Object.values(SECRET_IDS) },
  );
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = value[key];
  if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error(`${key} was not an object`);
  return next as Record<string, unknown>;
}

describe("agentic-chat settings migration", function () {
  it("loads existing data.json, heals legacy fields, and migrates plaintext secrets", async function () {
    await installLegacyDataAndReloadPlugin();
    const state = await readMigrationState();

    expect(state.settings.provider).toBe("openai-compatible");
    expect(state.settings.openrouterApiKey).toBe("legacy-openrouter-key");
    expect(state.settings.openaiCompatibleBaseUrl).toBe("https://legacy-gateway.example/api");
    expect(state.settings.openaiCompatibleApiKey).toBe("legacy-openai-compatible-key");
    expect(state.settings.openaiCompatibleModel).toBe("legacy/model");
    expect(state.settings.mode).toBe("safe");
    expect(state.settings.approval).toMatchObject({
      mutating: "ask",
      perTool: { write: "allow" },
      workingDirs: [],
    });
    expect(state.settings.web).toMatchObject({
      enabled: true,
      searchProvider: "searxng",
      searchApiKey: "legacy-web-key",
      searxngUrl: "https://search.example.com",
      maxResults: 8,
      fetchCharLimit: 15_000,
    });

    const server = state.settings.mcp.servers[0];
    expect(state.settings.mcp.enabled).toBe(true);
    expect(state.settings.mcp.proxyUrl).toBe("http://proxy.example.com:8080/");
    expect(state.settings.mcp.noProxy).toBe("localhost,*.example.com");
    expect(server).toMatchObject({
      id: "docs",
      name: "Docs MCP",
      url: "https://docs.example.com/mcp",
      authType: "bearer",
      authHeaderValueSecretId: SECRET_IDS.mcpAuth,
      authHeaderValue: "legacy-mcp-token",
      approval: "allow",
      knownTools: [{ name: "search", title: "Search docs", readOnlyHint: true }],
    });
    expect(server.oauth).toMatchObject({
      clientId: "legacy-client",
      clientSecretSecretId: SECRET_IDS.mcpClientSecret,
      clientSecret: "legacy-client-secret",
      accessTokenSecretId: SECRET_IDS.mcpAccessToken,
      accessToken: "legacy-access-token",
      refreshTokenSecretId: SECRET_IDS.mcpRefreshToken,
      refreshToken: "legacy-refresh-token",
      expiresAt: 123,
      scope: "docs.read",
    });

    expect(state.secrets[SECRET_IDS.openrouter]).toBe("legacy-openrouter-key");
    expect(state.secrets[SECRET_IDS.openaiCompatible]).toBe("legacy-openai-compatible-key");
    expect(state.secrets[SECRET_IDS.webSearch]).toBe("legacy-web-key");
    expect(state.secrets[SECRET_IDS.mcpAuth]).toBe("legacy-mcp-token");
    expect(state.secrets[SECRET_IDS.mcpClientSecret]).toBe("legacy-client-secret");
    expect(state.secrets[SECRET_IDS.mcpAccessToken]).toBe("legacy-access-token");
    expect(state.secrets[SECRET_IDS.mcpRefreshToken]).toBe("legacy-refresh-token");

    expect(state.stored.openrouterApiKey).toBe("");
    expect(state.stored.openaiCompatibleApiKey).toBe("");
    expect(objectAt(state.stored, "web").searchApiKey).toBe("");
    const storedMcp = objectAt(state.stored, "mcp");
    const storedServer = (storedMcp.servers as Array<Record<string, unknown>>)[0];
    expect(storedServer.authHeaderValue).toBe("");
    const storedOAuth = objectAt(storedServer, "oauth");
    expect(storedOAuth.clientSecret).toBe("");
    expect(storedOAuth.accessToken).toBe("");
    expect(storedOAuth.refreshToken).toBe("");

    await browser.executeObsidianCommand("agentic-chat:open-chat");
    await $(".agentic-chat-view").waitForExist();
  });
});
