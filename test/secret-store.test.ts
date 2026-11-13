import { describe, expect, it } from "vitest";
import { createMcpServerSettings, createMcpServerState } from "../src/mcp/settings";
import { DEFAULT_SETTINGS, mergeSettings, type AgenticChatSettings } from "../src/settings-schema";
import {
  SETTINGS_SECRET_SLOTS,
  hydrateSettingsSecrets,
  MemorySecretStore,
  settingsForStorage,
} from "../src/secrets/secret-store";
import { migrateLegacyPlaintextSecrets, withUnmigratedSecrets } from "../src/secrets/legacy-plaintext";

describe("secret storage migration", () => {
  it("keeps top-level secret handling in one registry", () => {
    expect(SETTINGS_SECRET_SLOTS.map((slot) => slot.valuePath.join("."))).toEqual([
      "openrouterApiKey",
      "openaiCompatibleApiKey",
      "web.searchApiKey",
      "observability.langfusePublicKey",
      "observability.langfuseSecretKey",
      "observability.authHeaderValue",
    ]);
  });

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
    server.oauth.clientSecret = "oauth-client-VALUE";
    server.oauth.accessToken = "oauth-access-VALUE";
    server.oauth.refreshToken = "oauth-refresh-VALUE";

    const store = new MemorySecretStore();
    // Legacy plaintext is not read by mergeSettings: it moves through the
    // explicit one-time migration, then hydration fills the runtime cache.
    const raw = {
      openrouterApiKey: "openrouter-secret",
      openaiCompatibleApiKey: "openai-secret",
      web: { searchApiKey: "search-secret" },
      observability: {
        langfusePublicKey: "pk-lf-public",
        langfuseSecretKey: "sk-lf-secret",
        authHeaderValue: "Bearer otel-token",
      },
      mcp: { enabled: true, servers: [server] },
    };
    migrateLegacyPlaintextSecrets(raw, store);
    const settings = mergeSettings(raw as unknown as Partial<AgenticChatSettings>);
    hydrateSettingsSecrets(settings, store);

    const stored = settingsForStorage(settings, store);

    expect("openrouterApiKey" in stored).toBe(false);
    expect((stored.observability as unknown as Record<string, unknown>).langfusePublicKey).toBeUndefined();
    expect((stored.observability as unknown as Record<string, unknown>).langfuseSecretKey).toBeUndefined();
    expect((stored.observability as unknown as Record<string, unknown>).authHeaderValue).toBeUndefined();
    expect((stored.mcp.servers[0] as unknown as Record<string, unknown>).authHeaderValue).toBeUndefined();
    expect((stored.mcp.servers[0].oauth as unknown as Record<string, unknown>).clientSecret).toBeUndefined();
    expect((stored.mcp.servers[0].oauth as unknown as Record<string, unknown>).accessToken).toBeUndefined();
    expect((stored.mcp.servers[0].oauth as unknown as Record<string, unknown>).refreshToken).toBeUndefined();
    // Persisted JSON must omit plaintext keys entirely (not even "").
    expect("openrouterApiKey" in stored).toBe(false);
    expect("openaiCompatibleApiKey" in stored).toBe(false);
    expect("searchApiKey" in stored.web).toBe(false);
    expect("langfusePublicKey" in stored.observability).toBe(false);
    expect("langfuseSecretKey" in stored.observability).toBe(false);
    expect("authHeaderValue" in stored.observability).toBe(false);
    expect("authHeaderValue" in (stored.mcp.servers[0] as unknown as Record<string, unknown>)).toBe(false);
    const storedOAuth = stored.mcp.servers[0].oauth as unknown as Record<string, unknown>;
    expect("clientSecret" in storedOAuth).toBe(false);
    expect("accessToken" in storedOAuth).toBe(false);
    expect("refreshToken" in storedOAuth).toBe(false);

    expect(store.getSecret(stored.openrouterApiKeySecretId)).toBe("openrouter-secret");
    expect(store.getSecret(stored.openaiCompatibleApiKeySecretId)).toBe("openai-secret");
    expect(store.getSecret(stored.web.searchApiKeySecretId)).toBe("search-secret");
    expect(store.getSecret(stored.observability.langfusePublicKeySecretId)).toBe("pk-lf-public");
    expect(store.getSecret(stored.observability.langfuseSecretKeySecretId)).toBe("sk-lf-secret");
    expect(store.getSecret(stored.observability.authHeaderValueSecretId)).toBe("Bearer otel-token");
    expect(store.getSecret(stored.mcp.servers[0].authHeaderValueSecretId)).toBe("docs-secret");
    expect(store.getSecret(stored.mcp.servers[0].oauth.clientSecretSecretId)).toBe("oauth-client-VALUE");
    expect(store.getSecret(stored.mcp.servers[0].oauth.accessTokenSecretId)).toBe("oauth-access-VALUE");
    expect(store.getSecret(stored.mcp.servers[0].oauth.refreshTokenSecretId)).toBe("oauth-refresh-VALUE");
  });

  it("hydrates runtime settings from secret references", () => {
    const settings = mergeSettings(null);
    const store = new MemorySecretStore();
    store.setSecret(settings.openrouterApiKeySecretId, "openrouter-secret");
    store.setSecret(settings.openaiCompatibleApiKeySecretId, "openai-secret");
    store.setSecret(settings.web.searchApiKeySecretId, "search-secret");
    store.setSecret(settings.observability.langfusePublicKeySecretId, "pk-lf-public");
    store.setSecret(settings.observability.langfuseSecretKeySecretId, "sk-lf-secret");
    store.setSecret(settings.observability.authHeaderValueSecretId, "Bearer otel-token");

    hydrateSettingsSecrets(settings, store);

    expect(settings.openrouterApiKey).toBe("openrouter-secret");
    expect(settings.openaiCompatibleApiKey).toBe("openai-secret");
    expect(settings.web.searchApiKey).toBe("search-secret");
    expect(settings.observability.langfusePublicKey).toBe("pk-lf-public");
    expect(settings.observability.langfuseSecretKey).toBe("sk-lf-secret");
    expect(settings.observability.authHeaderValue).toBe("Bearer otel-token");
  });

  it("round-trips legacy plaintext through omission back to hydrated runtime", () => {
    const server = {
      ...createMcpServerSettings({
        id: "docs",
        name: "Docs MCP",
        url: "https://mcp.example.com/mcp",
        authType: "bearer",
      }),
      authHeaderValue: "docs-secret",
    };
    server.oauth.clientSecret = "oauth-client-VALUE";
    server.oauth.accessToken = "oauth-access-VALUE";
    server.oauth.refreshToken = "oauth-refresh-VALUE";
    const stateEntry = createMcpServerState("plugin_docs_docs", { enabled: true, authType: "header" });
    stateEntry.authHeaderValue = "state-secret";
    const raw = {
      openrouterApiKey: "or-roundtrip",
      openaiCompatibleApiKey: "oai-roundtrip",
      web: { searchApiKey: "search-roundtrip" },
      observability: {
        langfusePublicKey: "pk-roundtrip",
        langfuseSecretKey: "sk-roundtrip",
        authHeaderValue: "Bearer otel-roundtrip",
      },
      mcp: { enabled: true, servers: [server] },
      plugins: { mcpState: { plugin_docs_docs: stateEntry } },
    };
    const store = new MemorySecretStore();
    migrateLegacyPlaintextSecrets(raw, store);
    const legacy = mergeSettings(raw as unknown as Partial<AgenticChatSettings>);
    hydrateSettingsSecrets(legacy, store);

    const stored = settingsForStorage(legacy, store);
    const json = JSON.stringify(stored);
    for (const secret of [
      "or-roundtrip",
      "oai-roundtrip",
      "search-roundtrip",
      "pk-roundtrip",
      "sk-roundtrip",
      "Bearer otel-roundtrip",
      "docs-secret",
      "oauth-client-VALUE",
      "oauth-access-VALUE",
      "oauth-refresh-VALUE",
      "state-secret",
    ]) {
      expect(json).not.toContain(secret);
    }
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect("openrouterApiKey" in parsed).toBe(false);
    expect("openaiCompatibleApiKey" in parsed).toBe(false);

    // Second load: omitted keys heal to defaults, then hydrate restores from secretStorage.
    const reloaded = mergeSettings(JSON.parse(json) as Partial<typeof DEFAULT_SETTINGS>);
    expect(reloaded.openrouterApiKey).toBe("");
    expect(reloaded.openaiCompatibleApiKey).toBe("");
    expect(reloaded.web.searchApiKey).toBe("");
    expect(reloaded.observability.langfusePublicKey).toBe("");
    expect(reloaded.observability.langfuseSecretKey).toBe("");
    expect(reloaded.observability.authHeaderValue).toBe("");
    hydrateSettingsSecrets(reloaded, store);
    expect(reloaded.openrouterApiKey).toBe("or-roundtrip");
    expect(reloaded.openaiCompatibleApiKey).toBe("oai-roundtrip");
    expect(reloaded.web.searchApiKey).toBe("search-roundtrip");
    expect(reloaded.observability.langfusePublicKey).toBe("pk-roundtrip");
    expect(reloaded.observability.langfuseSecretKey).toBe("sk-roundtrip");
    expect(reloaded.observability.authHeaderValue).toBe("Bearer otel-roundtrip");
    expect(reloaded.mcp.servers[0].authHeaderValue).toBe("docs-secret");
    expect(reloaded.mcp.servers[0].oauth.clientSecret).toBe("oauth-client-VALUE");
    expect(reloaded.mcp.servers[0].oauth.accessToken).toBe("oauth-access-VALUE");
    expect(reloaded.mcp.servers[0].oauth.refreshToken).toBe("oauth-refresh-VALUE");
    expect(reloaded.plugins.mcpState["plugin_docs_docs"].authHeaderValue).toBe("state-secret");

    // Third save without re-entry must not wipe good secrets (skip-on-absent).
    const restorted = settingsForStorage(reloaded, store);
    const rejson = JSON.stringify(restorted);
    expect(rejson).not.toContain("or-roundtrip");
    const reloaded2 = mergeSettings(JSON.parse(rejson) as Partial<typeof DEFAULT_SETTINGS>);
    hydrateSettingsSecrets(reloaded2, store);
    expect(reloaded2.openrouterApiKey).toBe("or-roundtrip");
    expect(reloaded2.web.searchApiKey).toBe("search-roundtrip");
    expect(reloaded2.observability.langfuseSecretKey).toBe("sk-roundtrip");
    expect(reloaded2.mcp.servers[0].authHeaderValue).toBe("docs-secret");
    expect(reloaded2.plugins.mcpState["plugin_docs_docs"].authHeaderValue).toBe("state-secret");
  });

  it("does not read plaintext secrets from mergeSettings without the one-time migration", () => {
    const merged = mergeSettings({
      ...DEFAULT_SETTINGS,
      openrouterApiKey: "plain-or",
      openaiCompatibleApiKey: "plain-oai",
      web: { ...DEFAULT_SETTINGS.web, searchApiKey: "plain-search" },
      observability: {
        ...DEFAULT_SETTINGS.observability,
        langfusePublicKey: "plain-pk",
        langfuseSecretKey: "plain-sk",
        authHeaderValue: "plain-header",
      },
      mcp: {
        ...DEFAULT_SETTINGS.mcp,
        servers: [
          {
            ...createMcpServerSettings({
              id: "docs",
              name: "Docs",
              url: "https://mcp.example.com/mcp",
              authType: "bearer",
            }),
            authHeaderValue: "plain-mcp",
          },
        ],
      },
    } as Partial<AgenticChatSettings>);
    expect(merged.openrouterApiKey).toBe("");
    expect(merged.openaiCompatibleApiKey).toBe("");
    expect(merged.web.searchApiKey).toBe("");
    expect(merged.observability.langfusePublicKey).toBe("");
    expect(merged.observability.langfuseSecretKey).toBe("");
    expect(merged.observability.authHeaderValue).toBe("");
    expect(merged.mcp.servers[0].authHeaderValue).toBe("");
    expect(merged.mcp.servers[0].oauth.accessToken).toBe("");
  });

  it("hydrates old empty-string format and coerces corrupt non-string plaintext", () => {
    const legacy = mergeSettings({
      ...DEFAULT_SETTINGS,
      openrouterApiKey: "",
      openaiCompatibleApiKey: 123 as unknown as string,
    });
    // Corrupt non-string input heals to "" instead of throwing on .trim().
    expect(legacy.openrouterApiKey).toBe("");
    expect(legacy.openaiCompatibleApiKey).toBe("");
    const store = new MemorySecretStore();
    store.setSecret(legacy.openrouterApiKeySecretId, "store-key");
    hydrateSettingsSecrets(legacy, store);
    expect(legacy.openrouterApiKey).toBe("store-key");
    // Empty store + empty format stays empty and saves without wiping.
    const emptyStore = new MemorySecretStore();
    const blank = mergeSettings({ ...DEFAULT_SETTINGS, openrouterApiKey: "" });
    hydrateSettingsSecrets(blank, emptyStore);
    expect(blank.openrouterApiKey).toBe("");
    const stored = settingsForStorage(blank, emptyStore);
    expect("openrouterApiKey" in stored).toBe(false);
    expect(emptyStore.getSecret(blank.openrouterApiKeySecretId)).toBe("");
  });
});

describe("legacy plaintext secret migration (#285)", () => {
  class ThrowingSecretStore extends MemorySecretStore {
    override setSecret(): void {
      throw new Error("secret storage unavailable");
    }
  }

  it("does not overwrite a newer value already in the secret store", () => {
    const store = new MemorySecretStore();
    store.setSecret("agentic-chat-openrouter-api-key", "NEW");
    const raw: Record<string, unknown> = { openrouterApiKey: "OLD" };

    migrateLegacyPlaintextSecrets(raw, store);

    expect(store.getSecret("agentic-chat-openrouter-api-key")).toBe("NEW");
    expect("openrouterApiKey" in raw).toBe(false);
  });

  it("repoints a malformed configured secret id at the fallback id so hydration finds the value", () => {
    const store = new MemorySecretStore();
    const raw: Record<string, unknown> = { openrouterApiKey: "legacy-key", openrouterApiKeySecretId: "!!!" };

    migrateLegacyPlaintextSecrets(raw, store);
    const settings = mergeSettings(raw as unknown as Partial<AgenticChatSettings>);
    hydrateSettingsSecrets(settings, store);

    expect(settings.openrouterApiKeySecretId).toBe("agentic-chat-openrouter-api-key");
    expect(settings.openrouterApiKey).toBe("legacy-key");
  });

  it("reports a failed write instead of throwing and keeps the value in memory only", () => {
    const store = new ThrowingSecretStore();
    const raw: Record<string, unknown> = { openrouterApiKey: "legacy-key" };

    let failures: ReturnType<typeof migrateLegacyPlaintextSecrets> = [];
    expect(() => {
      failures = migrateLegacyPlaintextSecrets(raw, store);
    }).not.toThrow();
    expect(failures).toHaveLength(1);
    expect(failures[0].secretId).toBe("agentic-chat-openrouter-api-key");
    expect(JSON.stringify(raw)).not.toContain("legacy-key");

    const settings = mergeSettings(raw as unknown as Partial<AgenticChatSettings>);
    hydrateSettingsSecrets(settings, withUnmigratedSecrets(store, failures));
    expect(settings.openrouterApiKey).toBe("legacy-key");
    // The save path still omits plaintext from data.json.
    expect(JSON.stringify(settingsForStorage(settings, new MemorySecretStore()))).not.toContain("legacy-key");
  });

  it("keeps distinct secrets for MCP servers that have no id", () => {
    const store = new MemorySecretStore();
    const raw: Record<string, unknown> = {
      mcp: {
        enabled: true,
        servers: [
          { name: "Alpha", url: "https://alpha.example.com/mcp", authType: "bearer", authHeaderValue: "alpha-secret" },
          { name: "Beta", url: "https://beta.example.com/mcp", authType: "bearer", authHeaderValue: "beta-secret" },
        ],
      },
    };

    migrateLegacyPlaintextSecrets(raw, store);
    const settings = mergeSettings(raw as unknown as Partial<AgenticChatSettings>);
    hydrateSettingsSecrets(settings, store);

    expect(settings.mcp.servers.map((server) => server.authHeaderValue)).toEqual(["alpha-secret", "beta-secret"]);
  });
});
