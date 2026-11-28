import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { applyOpenAICompatiblePreset, OPENAI_COMPATIBLE_PRESETS, openAICompatiblePresetForBaseUrl } from "../src/settings";
import {
  activeModelConfig,
  activeModelId,
  apiKeyForProvider,
  DEFAULT_SETTINGS,
  mergeSettings,
  retiredSettingsNotices,
  type AgenticChatSettings,
} from "../src/settings-schema";
import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL } from "../src/llm/models";
import {
  DEFAULT_MCP_SETTINGS,
  createMcpServerSettings,
  normalizeMcpServerId,
} from "../src/mcp/settings";
import { mcpSecretId, normalizeSecretId } from "../src/secrets/secret-store";
import { copyToClipboard } from "../src/settings-definition-kit";
import {
  clearMcpKnownToolsAndApprovals,
  renameMcpServer,
  updateMcpServerEndpoint,
} from "../src/settings-mcp-edits";
import { endMcpOAuthProgress, handleMcpOAuthProgress } from "../src/settings-mcp-section";
import {
  mcpAuthProblem,
  mcpCredentialResourceChanged,
  mcpTestButtonState,
} from "../src/settings-mcp-state";
import pastDefaultPrompts from "./fixtures/past-default-prompts.json";

describe("default OpenRouter model", () => {
  it("is DeepSeek v4.1 Flash for a new install", () => {
    expect(DEFAULT_SETTINGS.openrouterModel).toBe("deepseek/deepseek-v4.1-flash");
    expect(mergeSettings(undefined).openrouterModel).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("keeps a model an existing user already saved", () => {
    expect(mergeSettings({ openrouterModel: "moonshotai/kimi-k2.6" }).openrouterModel).toBe("moonshotai/kimi-k2.6");
  });
});

describe("retired system prompt notice", () => {
  const notices = (systemPrompt: string) =>
    retiredSettingsNotices({ systemPrompt }).filter((notice) => notice.includes("System prompt"));

  it.each(pastDefaultPrompts.map((prompt, index) => [index, prompt] as const))(
    "stays quiet for shipped default %i",
    (_index, prompt) => {
      expect(notices(prompt)).toEqual([]);
    },
  );

  it("still names a prompt the user wrote or extended", () => {
    expect(notices("Answer in Hungarian.")).toHaveLength(1);
    expect(notices(`${pastDefaultPrompts[1]}\nAnswer in Hungarian.`)).toHaveLength(1);
  });
});

describe("settings format version", () => {
  it.each(["broken", 7, true, []])("heals a data.json that is not an object (%j) to the defaults", (stored) => {
    expect(mergeSettings(stored as never)).toEqual(mergeSettings(undefined));
  });

  it("stamps the current version on a fresh or older data.json", () => {
    expect(mergeSettings(null).settingsVersion).toBe(1);
    expect(mergeSettings({ settingsVersion: 0 } as never).settingsVersion).toBe(1);
  });

  it("refuses a data.json written by a newer version instead of overwriting it with defaults", () => {
    expect(() => mergeSettings({ settingsVersion: 2 } as never)).toThrow(/newer version/i);
  });
});

describe("mergeSettings — retired working directories", () => {
  it("loads an old data.json with approval.workingDirs and drops the key", () => {
    const merged = mergeSettings({
      approval: { mutating: "ask", perTool: { write: "allow" }, workingDirs: ["Notes", "Work"] },
    } as unknown as Partial<AgenticChatSettings>);
    expect(merged.approval).toEqual({ mutating: "ask", perTool: { write: "allow" } });
    expect("workingDirs" in merged.approval).toBe(false);
    expect(JSON.stringify(merged)).not.toContain("workingDirs");
  });

  it("ignores malformed legacy workingDirs instead of crashing the load", () => {
    const malformed = ["Notes", null, { path: "Notes" }, 3];
    for (const workingDirs of malformed) {
      const merged = mergeSettings({
        approval: { mutating: "ask", perTool: {}, workingDirs },
      } as unknown as Partial<AgenticChatSettings>);
      expect(merged.approval.mutating).toBe("ask");
      expect("workingDirs" in merged.approval).toBe(false);
    }
  });

  it("keeps the approval policy and per-tool map while dropping workingDirs", () => {
    const merged = mergeSettings({
      approval: { mutating: "deny", perTool: { write: "ask" } },
    } as unknown as Partial<AgenticChatSettings>);
    expect(merged.approval).toEqual({ mutating: "deny", perTool: { write: "ask" } });
  });
});

describe("mergeSettings — defaults", () => {
  it("drops removed sampling and concurrency keys instead of carrying them", () => {
    const merged = mergeSettings({
      temperature: 0.9,
      maxTokens: 8_192,
      requestTimeoutMs: 10_000,
      maxNetworkRetries: 5,
      maxParallelSubagents: 3,
      systemPrompt: "custom",
      compaction: { enabled: true, thresholdPercent: 60 },
      web: { enabled: true, maxResults: 9, fetchCharLimit: 500 },
    } as never) as unknown as Record<string, unknown>;
    for (const key of [
      "temperature",
      "maxTokens",
      "requestTimeoutMs",
      "maxNetworkRetries",
      "maxParallelSubagents",
      "systemPrompt",
    ]) {
      expect(key in merged).toBe(false);
    }
    expect((merged.compaction as Record<string, unknown>).thresholdPercent).toBeUndefined();
    expect((merged.web as Record<string, unknown>).maxResults).toBeUndefined();
    expect((merged.web as Record<string, unknown>).fetchCharLimit).toBeUndefined();
    expect((merged.web as Record<string, unknown>).enabled).toBe(true);
  });

  it("drops the removed turn cap and subagent timeout from a stored data.json (U4)", () => {
    const merged = mergeSettings({ maxTurnsPerPrompt: 60, subagentTimeoutSeconds: 300 } as never) as unknown as Record<string, unknown>;
    expect(merged.maxTurnsPerPrompt).toBeUndefined();
    expect(merged.subagentTimeoutSeconds).toBeUndefined();
  });

  it("drops a legacy projects key from stored settings", () => {
    const merged = mergeSettings({
      approval: { mutating: "ask", perTool: {} },
      projects: { activeProjectId: "alpha", items: [{ id: "alpha", name: "Alpha", folders: ["A"] }] },
    } as unknown as Partial<AgenticChatSettings>);
    expect(JSON.stringify(merged)).not.toContain("projects");
    expect((merged as unknown as Record<string, unknown>).projects).toBeUndefined();
  });
});

describe("settings — OpenAI-compatible provider", () => {
  it("defaults generic provider fields without mutating the default provider", () => {
    const merged = mergeSettings(null);
    expect(merged.provider).toBe("openrouter");
    expect(merged.openaiCompatibleBaseUrl).toBe(DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
    expect(merged.openaiCompatibleApiKey).toBe("");
    expect(merged.openaiCompatibleModel).toBe("");
    expect(merged.openaiCompatibleContextWindow).toBe(0);
  });

  it("heals the context-window override to 0 for missing or malformed values", () => {
    expect(mergeSettings({ openaiCompatibleContextWindow: -5 }).openaiCompatibleContextWindow).toBe(0);
    expect(mergeSettings({ openaiCompatibleContextWindow: 1.7 }).openaiCompatibleContextWindow).toBe(1);
    expect(mergeSettings({ openaiCompatibleContextWindow: "big" as unknown as number }).openaiCompatibleContextWindow).toBe(0);
    expect(mergeSettings({ openaiCompatibleContextWindow: 32_000 }).openaiCompatibleContextWindow).toBe(32_000);
  });

  it("carries the context-window override into the model config", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      provider: "openai-compatible" as const,
      openaiCompatibleContextWindow: 64_000,
    };
    expect(activeModelConfig(settings).openaiCompatibleContextWindow).toBe(64_000);
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
        proxyUrl: " http://192.0.2.10:3128/ ",
        noProxy: " localhost, *.internal.example, localhost ",
      },
    });

    expect(merged.network).toEqual({
      proxyUrl: "http://192.0.2.10:3128/",
      noProxy: "localhost,*.internal.example",
    });
    expect(mergeSettings({ network: { proxyUrl: "socks://proxy:1080", noProxy: "" } }).network.proxyUrl).toBe("");
  });
});

describe("mergeSettings — removed tool budget", () => {
  it("drops a stale toolBudget key from older data.json instead of carrying it forward", () => {
    const merged = mergeSettings({ toolBudget: { enabled: false, thresholdPercent: 7 } } as never);
    expect("toolBudget" in merged).toBe(false);
  });
});

describe("normalizeSecretId", () => {
  it("keeps short ids unchanged and caps long ids at 64 chars with a stable hash", () => {
    expect(normalizeSecretId("agentic-chat-mcp-docs-oauth-client-secret")).toBe(
      "agentic-chat-mcp-docs-oauth-client-secret",
    );
    const long = normalizeSecretId(
      "agentic-chat-mcp-plugin-swe-context7-8932e260-oauth-client-secret",
    );
    expect(long.length).toBe(64);
    expect(long).toMatch(/^agentic-chat-mcp-plugin-swe-context7-8932e260-oauth-[a-f0-9]{12}$/);
    expect(normalizeSecretId("agentic-chat-mcp-plugin-swe-context7-8932e260-oauth-client-secret")).toBe(long);
  });

  it("distinguishes long ids that share the retained prefix", () => {
    const a = normalizeSecretId("agentic-chat-mcp-plugin-swe-context7-8932e260-oauth-client-secret");
    const b = normalizeSecretId("agentic-chat-mcp-plugin-swe-context7-8932e260-oauth-access-token");
    expect(b.slice(0, 51)).toBe(a.slice(0, 51));
    expect(b.slice(-12)).not.toBe(a.slice(-12));
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
  });

  it("drops the retired mcp.servers list and keeps only proxy settings", () => {
    const stored = {
      mcp: {
        enabled: true,
        proxyUrl: " http://192.0.2.10:3128/ ",
        noProxy: " localhost, *.internal.example, localhost ",
        servers: [
          {
            id: "Context 7!",
            name: " Docs MCP ",
            url: " https://mcp.example.com/mcp ",
            source: "user",
            authHeaderValue: "secret-token",
          },
          {
            id: "plugin_srv",
            name: "Plugin",
            url: "https://plugin.example.com/mcp",
            source: "plugin",
          },
        ],
      },
    };
    const merged = mergeSettings(stored as never);

    expect(merged.mcp).toEqual({
      enabled: true,
      proxyUrl: "http://192.0.2.10:3128/",
      noProxy: "localhost,*.internal.example",
    });
    expect(JSON.stringify(merged)).not.toContain("mcp.servers");

    const notices = retiredSettingsNotices(stored);
    expect(notices).toContainEqual(expect.stringContaining('"Docs MCP" (https://mcp.example.com/mcp)'));
    expect(notices.join(" ")).not.toContain("secret-token");
  });

  it("keeps credentials in a legacy server URL out of the one-time notice", () => {
    const notices = retiredSettingsNotices({
      mcp: {
        servers: [
          {
            id: "private",
            name: "Private",
            url: "https://user:pass@mcp.example.com/mcp?token=abc#fragment",
            source: "user",
          },
        ],
      },
    });
    const text = notices.join(" ");
    expect(text).toContain('"Private" (https://mcp.example.com/mcp)');
    expect(text).not.toContain("user");
    expect(text).not.toContain("pass");
    expect(text).not.toContain("token=abc");
    expect(text).not.toContain("fragment");
  });

  it("heals MCP proxy settings and rejects a non-http proxy", () => {
    const merged = mergeSettings({
      mcp: {
        enabled: true,
        proxyUrl: " http://192.0.2.10:3128/ ",
        noProxy: " localhost, *.internal.example, localhost ",
      },
    });

    expect(merged.mcp).toEqual({
      enabled: true,
      proxyUrl: "http://192.0.2.10:3128/",
      noProxy: "localhost,*.internal.example",
    });

    expect(mergeSettings({ mcp: { enabled: true, proxyUrl: "socks://proxy:1080", noProxy: "" } }).mcp.proxyUrl).toBe("");
  });

  it("heals S5 enabled/disabled_tools globs for state, including snake_case legacy keys", () => {
    const merged = mergeSettings({
      plugins: {
        folder: "",
        enabled: {},
        sources: {},
        mcpState: {
          plugin_srv: {
            enabled: true,
            approval: "allow",
            enabled_tools: ["read_*", " list_* ", "", "# c"],
            disabled_tools: "delete_*,*_danger",
            lastUrl: "https://srv.example.com/mcp",
          } as never,
        },
      },
    });

    expect(merged.plugins.mcpState.plugin_srv.enabledTools).toEqual(["read_*", "list_*"]);
    expect(merged.plugins.mcpState.plugin_srv.disabledTools).toEqual(["delete_*", "*_danger"]);
  });

  it("heals S5 tool globs to empty arrays when absent or malformed", () => {
    const merged = mergeSettings({
      plugins: {
        folder: "",
        enabled: {},
        sources: {},
        mcpState: {
          fresh: { enabled: true, approval: "ask", enabled_tools: 42 } as never,
        },
      },
    });

    expect(merged.plugins.mcpState.fresh.enabledTools).toEqual([]);
    expect(merged.plugins.mcpState.fresh.disabledTools).toEqual([]);
  });

  it("heals observability settings and proxy overrides", () => {
    const merged = mergeSettings({
      observability: {
        enabled: true,
        backend: "langfuse",
        endpoint: " https://langfuse.corp.example/ ",
        proxyUrl: " http://192.0.2.10:3128/ ",
        noProxy: " localhost, *.corp.example, localhost ",
        sampleRate: 150,
        payloadMode: "full-content",
      } as never,
    });

    expect(merged.observability).toMatchObject({
      enabled: true,
      backend: "langfuse",
      endpoint: "https://langfuse.corp.example",
      proxyUrl: "http://192.0.2.10:3128/",
      noProxy: "localhost,*.corp.example",
      sampleRate: 100,
      payloadMode: "full-content",
    });

    const healed = mergeSettings({
      observability: {
        enabled: true,
        backend: "bad",
        endpoint: "file:///tmp/traces",
        proxyUrl: "socks://proxy:1080",
        sampleRate: -1,
        payloadMode: "bad",
      } as never,
    });

    expect(healed.observability).toMatchObject({
      backend: "langfuse",
      endpoint: "",
      proxyUrl: "",
      sampleRate: 0,
      payloadMode: "metadata",
    });
  });

  it("heals cached MCP tool approval metadata in plugin state", () => {
    const merged = mergeSettings({
      plugins: {
        ...DEFAULT_SETTINGS.plugins,
        mcpState: {
          docs: {
            enabled: true,
            knownTools: [
              { name: " search_tools ", title: " Search Tools ", readOnlyHint: true },
              { name: "search_tools", title: "duplicate", readOnlyHint: false },
              { name: "", title: "bad", readOnlyHint: true },
            ],
          } as never,
        },
      },
    });

    expect(merged.plugins.mcpState.docs.knownTools).toEqual([
      { name: "search_tools", title: "Search Tools", readOnlyHint: true },
    ]);
  });

  it("rebases MCP per-tool approvals and secret refs when a server id changes", () => {
    const settings = mergeSettings({
      approval: {
        mutating: "ask",
        perTool: {
          mcp__docs__resolve_library_id: "allow",
          mcp__docs__resolve_library_id_2: "deny",
        },
      },
    });
    const server = {
      ...createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }),
      authType: "bearer" as const,
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
    };
    const clearedSecrets: Array<[string, string]> = [];
    const app = {
      secretStorage: { setSecret: (id: string, value: string) => clearedSecrets.push([id, value]) },
    } as unknown as App;
    const previousSecretIds = [
      server.authHeaderValueSecretId,
      server.oauth.clientSecretSecretId,
      server.oauth.accessTokenSecretId,
      server.oauth.refreshTokenSecretId,
    ];

    renameMcpServer(app, settings, server, "team_docs");

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
      },
    });
    const server = {
      ...createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }),
      knownTools: [{ name: "search", localName: "mcp__docs__search", title: "Search", readOnlyHint: false }],
    };
    clearMcpKnownToolsAndApprovals(settings, server);

    expect(server.knownTools).toEqual([]);
    expect(settings.approval.perTool).toEqual({ write: "ask" });
    expect(mcpCredentialResourceChanged("https://mcp.example.com/mcp?tools=a", "https://mcp.example.com/mcp?tools=b")).toBe(false);
    expect(mcpCredentialResourceChanged("https://mcp.example.com/mcp", "https://other.example.com/mcp")).toBe(true);
  });

  it("clears MCP credentials when endpoint edits pass through invalid URLs", () => {
    const settings = mergeSettings({
      approval: {
        mutating: "ask",
        perTool: { mcp__docs__search: "allow" },
      },
    });
    const server = {
      ...createMcpServerSettings({
        id: "docs",
        name: "Docs MCP",
        url: "https://a.example.com/mcp",
        authType: "bearer",
        authHeaderValue: "old-token",
      }),
      knownTools: [{ name: "search", localName: "mcp__docs__search", title: "Search", readOnlyHint: false }],
    };
    const invalid = updateMcpServerEndpoint(undefined, settings, server, "not a url");

    expect(invalid.clearedCredentials).toBe(true);
    expect(server.authHeaderValue).toBe("");
    expect(server.knownTools).toEqual([]);
    expect(settings.approval.perTool).toEqual({});
    expect(mcpCredentialResourceChanged("not a url", "https://b.example.com/mcp")).toBe(true);
  });

  it("enables newly configured MCP servers when a valid endpoint is entered", () => {
    const settings = mergeSettings({});
    const server = createMcpServerSettings({ id: "mcp" });
    expect(server.enabled).toBe(false);
    const result = updateMcpServerEndpoint(undefined, settings, server, "https://docs.example.com/mcp");

    expect(server.enabled).toBe(true);
    expect(server.id).toBe("docs");
    expect(result.shouldDisplay).toBe(true);
  });

  it("validates incomplete MCP static auth locally before connection tests", () => {
    const bearer = createMcpServerSettings({ id: "docs", url: "https://mcp.example.com/mcp", authType: "bearer" });
    expect(mcpAuthProblem(bearer)).toMatch(/bearer token/i);
    expect(mcpTestButtonState(bearer).problem).toMatch(/bearer token/i);
    bearer.authHeaderValue = "token";
    expect(mcpTestButtonState(bearer).problem).toBe("");
    expect(
      mcpAuthProblem(
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

  it("keeps one live notice per server while OAuth sign-in runs (U7 #12)", async () => {
    const { Notice } = await import("obsidian");
    const rewrite = vi.spyOn(Notice.prototype, "setMessage");
    const server = createMcpServerSettings({ id: "docs", url: "https://mcp.example.com/mcp" });
    handleMcpOAuthProgress(server, { stage: "discovery", message: "Discovering OAuth metadata for Docs." });
    handleMcpOAuthProgress(server, { stage: "registration", message: "Preparing OAuth client for Docs." });
    handleMcpOAuthProgress(server, { stage: "browser-open", message: "Opening browser for Docs OAuth sign-in." });
    handleMcpOAuthProgress(server, { stage: "callback-wait", message: "Waiting for Docs OAuth browser callback." });
    // The first stage creates the notice; each later stage rewrites it, so they
    // never stack (five toasts covered the screen on a phone).
    expect(rewrite.mock.calls.map((call) => call[0])).toEqual([
      "Preparing OAuth client for Docs.",
      "Opening browser for Docs OAuth sign-in.",
      "Waiting for Docs OAuth browser callback.",
    ]);
    const hide = vi.spyOn(Notice.prototype, "hide");
    endMcpOAuthProgress(server);
    expect(hide).toHaveBeenCalledTimes(1);
    hide.mockRestore();
    rewrite.mockRestore();
  });

  it("does not throw when clipboard support is missing during OAuth progress", async () => {
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    await expect(copyToClipboard("https://auth.example.com")).resolves.toBe(false);
    expect(() =>
      handleMcpOAuthProgress(createMcpServerSettings({ id: "docs", url: "https://mcp.example.com/mcp" }), {
        stage: "authorization-url",
        message: "Created OAuth authorization URL.",
        detail: "https://auth.example.com/authorize",
      }),
    ).not.toThrow();

    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete (globalThis as { navigator?: Navigator }).navigator;
  });
});


