import { describe, expect, it } from "vitest";
import {
  activeModelConfig,
  activeModelId,
  AgenticChatSettingTab,
  applyOpenAICompatiblePreset,
  apiKeyForProvider,
  DEFAULT_SETTINGS,
  mergeSettings,
  OPENAI_COMPATIBLE_PRESETS,
  openAICompatiblePresetForBaseUrl,
  type AgenticChatSettings,
} from "../src/settings";
import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL } from "../src/llm/models";
import {
  DEFAULT_MCP_SETTINGS,
  createMcpServerSettings,
  mcpOAuthSettingsForServer,
  normalizeMcpServerId,
  type McpServerSettings,
} from "../src/mcp/settings";
import { mcpSecretId } from "../src/secrets/secret-store";

describe("mergeSettings — working directories", () => {
  it("defaults to an empty working set", () => {
    expect(mergeSettings(null).approval.workingDirs).toEqual([]);
    expect(mergeSettings({}).approval.workingDirs).toEqual([]);
  });

  it("keeps a stored string[] working set", () => {
    const merged = mergeSettings({ approval: { mutating: "ask", perTool: {}, workingDirs: ["Notes", "Work"] } });
    expect(merged.approval.workingDirs).toEqual(["Notes", "Work"]);
  });

  it("heals a malformed working set down to its string entries", () => {
    const merged = mergeSettings({
      // A corrupted persisted value: non-array / mixed types must not reach the gate.
      approval: { mutating: "ask", perTool: {}, workingDirs: ["ok", 3, null, "two"] as unknown as string[] },
    });
    expect(merged.approval.workingDirs).toEqual(["ok", "two"]);
  });

  it("treats a non-array working set as empty", () => {
    const merged = mergeSettings({
      approval: { mutating: "ask", perTool: {}, workingDirs: "Notes" as unknown as string[] },
    });
    expect(merged.approval.workingDirs).toEqual([]);
  });
});

describe("settings — OpenAI-compatible provider", () => {
  it("defaults generic provider fields without mutating the default provider", () => {
    const merged = mergeSettings(null);
    expect(merged.provider).toBe("openrouter");
    expect(merged.openaiCompatibleBaseUrl).toBe(DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
    expect(merged.openaiCompatibleApiKey).toBe("");
    expect(merged.openaiCompatibleModel).toBe("");
  });

  it("uses the generic provider model id and API key when selected", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      provider: "openai-compatible" as const,
      openaiCompatibleBaseUrl: "http://openwebui.local/api",
      openaiCompatibleApiKey: "  webui-key  ",
      openaiCompatibleModel: "qwen2.5-coder",
    };
    expect(activeModelId(settings)).toBe("qwen2.5-coder");
    expect(activeModelConfig(settings)).toMatchObject({
      provider: "openai-compatible",
      modelId: "qwen2.5-coder",
      openaiCompatibleBaseUrl: "http://openwebui.local/api",
    });
    expect(apiKeyForProvider(settings, "openai-compatible")).toBe("webui-key");
  });

  it("heals an unknown provider back to the default", () => {
    const merged = mergeSettings({ provider: "unknown" as typeof DEFAULT_SETTINGS.provider });
    expect(merged.provider).toBe(DEFAULT_SETTINGS.provider);
  });

  it("offers OpenAI-compatible gateway presets for common local and hosted gateways", () => {
    expect(OPENAI_COMPATIBLE_PRESETS.map((preset) => preset.id)).toEqual([
      "openwebui",
      "lm-studio",
      "vllm",
      "llama-cpp",
      "chutes",
      "venice",
    ]);
    expect(openAICompatiblePresetForBaseUrl("http://localhost:1234/v1/")).toMatchObject({
      id: "lm-studio",
      privacy: "local",
    });
    expect(openAICompatiblePresetForBaseUrl("https://api.venice.ai/api/v1")).toMatchObject({
      id: "venice",
      privacy: "hosted",
    });
  });

  it("applies OpenAI-compatible presets without changing provider transport shape", () => {
    const settings = { ...DEFAULT_SETTINGS };
    expect(applyOpenAICompatiblePreset(settings, "llama-cpp")).toBe(true);
    expect(settings).toMatchObject({
      provider: "openai-compatible",
      openaiCompatibleBaseUrl: "http://localhost:8080/v1",
      openrouterModel: DEFAULT_SETTINGS.openrouterModel,
      ollamaBaseUrl: DEFAULT_SETTINGS.ollamaBaseUrl,
    });
    expect(applyOpenAICompatiblePreset(settings, "missing")).toBe(false);
  });
});

describe("mergeSettings — network proxy", () => {
  it("defaults the global proxy off with localhost bypasses", () => {
    expect(mergeSettings(null).network).toEqual({
      proxyUrl: "",
      noProxy: "localhost,127.0.0.1,::1",
    });
  });

  it("heals global proxy settings", () => {
    const merged = mergeSettings({
      network: {
        proxyUrl: " http://10.36.148.11:3128/ ",
        noProxy: " localhost, *.internal.example, localhost ",
      },
    });

    expect(merged.network).toEqual({
      proxyUrl: "http://10.36.148.11:3128/",
      noProxy: "localhost,*.internal.example",
    });
    expect(mergeSettings({ network: { proxyUrl: "socks://proxy:1080", noProxy: "" } }).network.proxyUrl).toBe("");
  });
});

describe("mergeSettings — MCP", () => {
  it("defaults MCP off with no servers", () => {
    expect(mergeSettings(null).mcp).toEqual(DEFAULT_MCP_SETTINGS);
  });

  it("creates blank MCP servers disabled until an endpoint is entered", () => {
    expect(createMcpServerSettings({ id: "mcp" })).toMatchObject({
      url: "https://",
      enabled: false,
    });
    expect(
      createMcpServerSettings({ id: "docs", url: "https://mcp.example.com/mcp" }),
    ).toMatchObject({ enabled: true });
  });

  it("normalizes MCP server ids to delimiter-safe unique values", () => {
    expect(normalizeMcpServerId("Prod__Docs!!")).toBe("prod_docs");
    const merged = mergeSettings({
      mcp: {
        enabled: true,
        servers: [
          { id: "Prod__Docs", name: "Prod Docs", url: "https://mcp.example.com/mcp" },
          { id: "prod_docs", name: "Other Docs", url: "https://other.example.com/mcp" },
        ],
      } as never,
    });

    expect(merged.mcp.servers.map((server) => server.id)).toEqual(["prod_docs", "prod_docs_2"]);
  });

  it("heals stored MCP servers and defaults approval to ask", () => {
    const merged = mergeSettings({
      mcp: {
        enabled: true,
        proxyUrl: "",
        noProxy: "localhost,127.0.0.1,::1",
        servers: [
          {
            id: "Context 7!",
            name: " Docs MCP ",
            url: " https://mcp.example.com/mcp ",
            enabled: true,
            authHeaderName: " X-API-Key ",
            authHeaderValue: " secret ",
            approval: "wat" as "ask",
          } as never,
        ],
      } as never,
    });

    expect(merged.mcp).toEqual({
      enabled: true,
      proxyUrl: "",
      noProxy: "localhost,127.0.0.1,::1",
      servers: [
        {
          id: "context_7",
          name: "Docs MCP",
          url: "https://mcp.example.com/mcp",
          enabled: true,
          authType: "header",
          authHeaderName: "X-API-Key",
          authHeaderValueSecretId: mcpSecretId("context_7", "auth-header-value"),
          authHeaderValue: "secret",
          oauth: mcpOAuthSettingsForServer("context_7"),
          approval: "ask",
          knownTools: [],
        },
      ],
    });
  });

  it("heals MCP proxy settings", () => {
    const merged = mergeSettings({
      mcp: {
        enabled: true,
        proxyUrl: " http://10.36.148.11:3128/ ",
        noProxy: " localhost, *.internal.example, localhost ",
        servers: [],
      },
    });

    expect(merged.mcp).toMatchObject({
      proxyUrl: "http://10.36.148.11:3128/",
      noProxy: "localhost,*.internal.example",
    });

    expect(
      mergeSettings({ mcp: { enabled: true, proxyUrl: "socks://proxy:1080", servers: [] } as never }).mcp.proxyUrl,
    ).toBe("");
  });

  it("heals cached MCP tool approval metadata", () => {
    const merged = mergeSettings({
      mcp: {
        enabled: true,
        proxyUrl: "",
        noProxy: "localhost,127.0.0.1,::1",
        servers: [
          {
            ...createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }),
            knownTools: [
              { name: " search_tools ", title: " Search Tools ", readOnlyHint: true },
              { name: "search_tools", title: "duplicate", readOnlyHint: false },
              { name: "", title: "bad", readOnlyHint: true },
            ],
          },
        ],
      },
    });

    expect(merged.mcp.servers[0].knownTools).toEqual([
      { name: "search_tools", title: "Search Tools", readOnlyHint: true },
    ]);
  });

  it("migrates legacy preset-marked MCP servers into generic settings", () => {
    const merged = mergeSettings({
      mcp: {
        enabled: true,
        servers: [
          {
            preset: "oauth",
            id: "OAuth MCP",
            name: "OAuth MCP",
            url: "https://oauth-mcp.example.com/mcp?toolCategories=gitlab,knowledge&tools=query_company_knowledge",
            enabled: true,
            authHeaderName: "",
            authHeaderValue: "",
            approval: "allow",
          } as never,
        ],
      } as never,
    });

    expect(merged.mcp.servers[0]).toMatchObject({
      id: "oauth_mcp",
      name: "OAuth MCP",
      authType: "oauth",
      url: "https://oauth-mcp.example.com/mcp?toolCategories=gitlab,knowledge&tools=query_company_knowledge",
      approval: "allow",
      knownTools: [],
    });
    expect(merged.mcp.servers[0]).not.toHaveProperty("preset");
    expect(merged.mcp.servers[0]).not.toHaveProperty("legacyFilters");
  });

  it("migrates retired filter-object settings without preserving retired keys", () => {
    const merged = mergeSettings({
      mcp: {
        enabled: true,
        servers: [
          {
            id: "docs",
            name: "Docs MCP",
            url: "https://docs.example.com/mcp",
            authType: "oauth",
            legacyFilters: {
              toolCategories: ["gitlab", "knowledge"],
              tools: "query_company_knowledge",
            },
          } as never,
        ],
      } as never,
    });

    expect(merged.mcp.servers[0]).toMatchObject({
      id: "docs",
      authType: "oauth",
      url: "https://docs.example.com/mcp?toolCategories=gitlab%2Cknowledge&tools=query_company_knowledge",
    });
    expect(merged.mcp.servers[0]).not.toHaveProperty("preset");
    expect(merged.mcp.servers[0]).not.toHaveProperty("legacyFilters");
  });

  it("drops malformed MCP servers without URLs", () => {
    const merged = mergeSettings({
      mcp: {
        enabled: true,
        servers: [
          {
            id: "bad",
            name: "Bad",
            url: "",
            enabled: true,
            authHeaderName: "",
            authHeaderValue: "",
            approval: "ask",
          } as never,
        ],
      } as never,
    });

    expect(merged.mcp.servers).toEqual([]);
  });

  it("rebases MCP per-tool approvals and secret refs when a server id changes", () => {
    const settings = mergeSettings({
      approval: {
        mutating: "ask",
        perTool: {
          mcp__docs__resolve_library_id: "allow",
          mcp__docs__resolve_library_id_2: "deny",
        },
        workingDirs: [],
      },
      mcp: {
        enabled: true,
        proxyUrl: "",
        noProxy: "localhost,127.0.0.1,::1",
        servers: [
          {
            ...createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }),
            authType: "bearer",
            authHeaderValue: "secret",
            knownTools: [
              {
                name: "resolve-library-id",
                localName: "mcp__docs__resolve_library_id",
                title: "Resolve library",
                readOnlyHint: false,
              },
              {
                name: "resolve_library_id",
                localName: "mcp__docs__resolve_library_id_2",
                title: "Resolve library",
                readOnlyHint: false,
              },
            ],
          },
        ],
      },
    });
    const server = settings.mcp.servers[0];
    const clearedSecrets: Array<[string, string]> = [];
    const tab = Object.assign(Object.create(AgenticChatSettingTab.prototype), {
      app: { secretStorage: { setSecret: (id: string, value: string) => clearedSecrets.push([id, value]) } },
    }) as {
      renameMcpServer(settings: AgenticChatSettings, server: McpServerSettings, nextId: string): void;
    };
    const previousSecretIds = [
      server.authHeaderValueSecretId,
      server.oauth.clientSecretSecretId,
      server.oauth.accessTokenSecretId,
      server.oauth.refreshTokenSecretId,
    ];

    tab.renameMcpServer(settings, server, "team_docs");

    expect(server.id).toBe("team_docs");
    expect(server.authHeaderValueSecretId).toBe(mcpSecretId("team_docs", "auth-header-value"));
    expect(server.knownTools.map((tool) => tool.localName)).toEqual([
      "mcp__team_docs__resolve_library_id",
      "mcp__team_docs__resolve_library_id_2",
    ]);
    expect(settings.approval.perTool).toEqual({
      mcp__team_docs__resolve_library_id: "allow",
      mcp__team_docs__resolve_library_id_2: "deny",
    });
    expect(clearedSecrets).toEqual(previousSecretIds.map((id) => [id, ""]));
  });

  it("clears MCP per-tool approvals and cached tools when an endpoint changes", () => {
    const settings = mergeSettings({
      approval: {
        mutating: "ask",
        perTool: {
          mcp__docs__search: "allow",
          write: "ask",
        },
        workingDirs: [],
      },
      mcp: {
        enabled: true,
        proxyUrl: "",
        noProxy: "localhost,127.0.0.1,::1",
        servers: [
          {
            ...createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }),
            knownTools: [{ name: "search", localName: "mcp__docs__search", title: "Search", readOnlyHint: false }],
          },
        ],
      },
    });
    const server = settings.mcp.servers[0];
    const tab = Object.create(AgenticChatSettingTab.prototype) as {
      clearMcpKnownToolsAndApprovals(settings: AgenticChatSettings, server: McpServerSettings): void;
      mcpCredentialResourceChanged(previousUrl: string, nextUrl: string): boolean;
    };

    tab.clearMcpKnownToolsAndApprovals(settings, server);

    expect(server.knownTools).toEqual([]);
    expect(settings.approval.perTool).toEqual({ write: "ask" });
    expect(tab.mcpCredentialResourceChanged("https://mcp.example.com/mcp?tools=a", "https://mcp.example.com/mcp?tools=b")).toBe(false);
    expect(tab.mcpCredentialResourceChanged("https://mcp.example.com/mcp", "https://other.example.com/mcp")).toBe(true);
  });

  it("clears MCP credentials when endpoint edits pass through invalid URLs", () => {
    const settings = mergeSettings({
      mcp: {
        enabled: true,
        proxyUrl: "",
        noProxy: "localhost,127.0.0.1,::1",
        servers: [
          {
            ...createMcpServerSettings({
              id: "docs",
              name: "Docs MCP",
              url: "https://a.example.com/mcp",
              authType: "bearer",
              authHeaderValue: "old-token",
            }),
            knownTools: [{ name: "search", localName: "mcp__docs__search", title: "Search", readOnlyHint: false }],
          },
        ],
      },
      approval: {
        mutating: "ask",
        perTool: { mcp__docs__search: "allow" },
        workingDirs: [],
      },
    });
    const server = settings.mcp.servers[0];
    const tab = Object.create(AgenticChatSettingTab.prototype) as {
      updateMcpServerEndpoint(
        settings: AgenticChatSettings,
        server: McpServerSettings,
        value: string,
      ): { clearedCredentials: boolean; shouldDisplay: boolean };
      mcpCredentialResourceChanged(previousUrl: string, nextUrl: string): boolean;
    };

    const invalid = tab.updateMcpServerEndpoint(settings, server, "not a url");

    expect(invalid.clearedCredentials).toBe(true);
    expect(server.authHeaderValue).toBe("");
    expect(server.knownTools).toEqual([]);
    expect(settings.approval.perTool).toEqual({});
    expect(tab.mcpCredentialResourceChanged("not a url", "https://b.example.com/mcp")).toBe(true);
  });

  it("enables newly configured MCP servers when a valid endpoint is entered", () => {
    const settings = mergeSettings({
      mcp: {
        enabled: true,
        proxyUrl: "",
        noProxy: "localhost,127.0.0.1,::1",
        servers: [createMcpServerSettings({ id: "mcp" })],
      },
    });
    const server = settings.mcp.servers[0];
    const tab = Object.create(AgenticChatSettingTab.prototype) as {
      updateMcpServerEndpoint(
        settings: AgenticChatSettings,
        server: McpServerSettings,
        value: string,
      ): { clearedCredentials: boolean; shouldDisplay: boolean };
    };

    expect(server.enabled).toBe(false);
    const result = tab.updateMcpServerEndpoint(settings, server, "https://docs.example.com/mcp");

    expect(server.enabled).toBe(true);
    expect(server.id).toBe("docs");
    expect(result.shouldDisplay).toBe(true);
  });

  it("validates incomplete MCP static auth locally before connection tests", () => {
    const tab = Object.create(AgenticChatSettingTab.prototype) as {
      mcpAuthProblem(server: McpServerSettings): string;
      mcpTestButtonState(server: McpServerSettings): { problem: string };
    };

    const bearer = createMcpServerSettings({ id: "docs", url: "https://mcp.example.com/mcp", authType: "bearer" });
    expect(tab.mcpAuthProblem(bearer)).toMatch(/bearer token/i);
    expect(tab.mcpTestButtonState(bearer).problem).toMatch(/bearer token/i);
    bearer.authHeaderValue = "token";
    expect(tab.mcpTestButtonState(bearer).problem).toBe("");
    expect(
      tab.mcpAuthProblem(
        createMcpServerSettings({
          id: "docs",
          url: "https://mcp.example.com/mcp",
          authType: "header",
          authHeaderName: "Bad Header",
          authHeaderValue: "secret",
        }),
      ),
    ).toMatch(/header names/i);
  });

  it("does not throw when clipboard support is missing during OAuth progress", async () => {
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    const tab = Object.create(AgenticChatSettingTab.prototype) as {
      copyToClipboard(value: string): Promise<boolean>;
      handleMcpOAuthProgress(server: McpServerSettings, event: { stage: "authorization-url"; message: string; detail: string }): void;
    };

    await expect(tab.copyToClipboard("https://auth.example.com")).resolves.toBe(false);
    expect(() =>
      tab.handleMcpOAuthProgress(createMcpServerSettings({ id: "docs", url: "https://mcp.example.com/mcp" }), {
        stage: "authorization-url",
        message: "Created OAuth authorization URL.",
        detail: "https://auth.example.com/authorize",
      }),
    ).not.toThrow();

    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete (globalThis as { navigator?: Navigator }).navigator;
  });
});
