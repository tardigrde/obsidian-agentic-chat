import { describe, expect, it } from "vitest";
import { createMcpServerSettings } from "../src/mcp/settings";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings";
import { hydrateSettingsSecrets, MemorySecretStore, settingsForStorage } from "../src/secrets/secret-store";

describe("secret storage migration", () => {
  it("moves plaintext credentials to the secret store and stores only references in data", () => {
    const server = {
      ...createMcpServerSettings({
        id: "docs",
        name: "Docs MCP",
        url: "https://mcp.example.com/mcp",
        authType: "bearer",
      }),
      authHeaderValue: "docs-secret",
    };
    server.oauth.clientSecret = "oauth-client-secret";
    server.oauth.accessToken = "oauth-access";
    server.oauth.refreshToken = "oauth-refresh";

    const settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      openrouterApiKey: "openrouter-secret",
      openaiCompatibleApiKey: "openai-secret",
      web: {
        ...DEFAULT_SETTINGS.web,
        searchApiKey: "search-secret",
      },
      mcp: {
        ...DEFAULT_SETTINGS.mcp,
        enabled: true,
        servers: [server],
      },
    });
    const store = new MemorySecretStore();

    const stored = settingsForStorage(settings, store);

    expect(stored.openrouterApiKey).toBe("");
    expect(stored.openaiCompatibleApiKey).toBe("");
    expect(stored.web.searchApiKey).toBe("");
    expect(stored.mcp.servers[0].authHeaderValue).toBe("");
    expect(stored.mcp.servers[0].oauth.clientSecret).toBe("");
    expect(stored.mcp.servers[0].oauth.accessToken).toBe("");
    expect(stored.mcp.servers[0].oauth.refreshToken).toBe("");

    expect(store.getSecret(stored.openrouterApiKeySecretId)).toBe("openrouter-secret");
    expect(store.getSecret(stored.openaiCompatibleApiKeySecretId)).toBe("openai-secret");
    expect(store.getSecret(stored.web.searchApiKeySecretId)).toBe("search-secret");
    expect(store.getSecret(stored.mcp.servers[0].authHeaderValueSecretId)).toBe("docs-secret");
    expect(store.getSecret(stored.mcp.servers[0].oauth.clientSecretSecretId)).toBe("oauth-client-secret");
    expect(store.getSecret(stored.mcp.servers[0].oauth.accessTokenSecretId)).toBe("oauth-access");
    expect(store.getSecret(stored.mcp.servers[0].oauth.refreshTokenSecretId)).toBe("oauth-refresh");
  });

  it("hydrates runtime settings from secret references", () => {
    const settings = mergeSettings(null);
    const store = new MemorySecretStore();
    store.setSecret(settings.openrouterApiKeySecretId, "openrouter-secret");
    store.setSecret(settings.openaiCompatibleApiKeySecretId, "openai-secret");
    store.setSecret(settings.web.searchApiKeySecretId, "search-secret");

    hydrateSettingsSecrets(settings, store);

    expect(settings.openrouterApiKey).toBe("openrouter-secret");
    expect(settings.openaiCompatibleApiKey).toBe("openai-secret");
    expect(settings.web.searchApiKey).toBe("search-secret");
  });
});
