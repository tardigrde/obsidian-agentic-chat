import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_OAUTH_SETTINGS,
  applyMcpServerState,
  createMcpServerSettings,
  createMcpServerState,
  healMcpServerState,
  healMcpSettings,
  mcpServerStateFromServer,
  type McpServerSettings,
  type McpServerState,
} from "../src/mcp/settings";

/** The 12 client-owned fields the two shapes share. */
const SHARED_KEYS = [
  "enabled",
  "approval",
  "authType",
  "authHeaderName",
  "authHeaderValueSecretId",
  "authHeaderValue",
  "oauth",
  "knownTools",
  "enabledTools",
  "disabledTools",
  "pendingOAuthChallenge",
  "pendingOAuthResourceUrl",
] as const;

function pick(record: McpServerSettings | McpServerState): Record<string, unknown> {
  const raw = record as unknown as Record<string, unknown>;
  return Object.fromEntries(SHARED_KEYS.map((key) => [key, raw[key]]));
}

const servers: Array<{ label: string; input: Partial<McpServerSettings> }> = [
  { label: "defaults", input: { id: "docs", name: "Docs", url: "https://mcp.example/mcp" } },
  {
    label: "plugin server with static header auth",
    input: {
      id: "plugin_corp_api",
      name: "corp: api",
      url: "https://a.example/mcp",
      enabled: false,
      approval: "deny",
      authType: "header",
      authHeaderName: "X-API-Key",
      authHeaderValue: "static-secret",
      source: "plugin",
      pluginRoot: ".agentic-plugins/corp",
      headers: { "X-Tenant": "v1" },
      enabledTools: ["read_*"],
      disabledTools: ["*_danger"],
    },
  },
  {
    label: "oauth server with tokens and scope",
    input: {
      id: "oauth_mcp",
      name: "OAuth MCP",
      url: "https://oauth.example/mcp",
      authType: "oauth",
      oauth: {
        ...DEFAULT_MCP_OAUTH_SETTINGS,
        clientId: "client-1",
        clientSecret: "client-secret",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 1234,
        scope: "openid profile",
      },
    },
  },
  {
    label: "discovered tools",
    input: {
      id: "tools",
      name: "Tools",
      url: "https://tools.example/mcp",
      enabled: true,
      approval: "allow",
      knownTools: [
        { name: "get_time", localName: "mcp__tools__get_time", title: "Get time", readOnlyHint: true },
      ],
    },
  },
];

describe("MCP server shape round-trip", () => {
  it.each(servers)("$label: settings -> state -> settings keeps the shared fields", ({ input }) => {
    const server = createMcpServerSettings(input);
    const state = mcpServerStateFromServer(server);

    expect(pick(state)).toEqual(pick(server));
    expect(state.lastUrl).toBe(server.url);

    const copy = { ...server, oauth: { ...server.oauth }, knownTools: [...server.knownTools] };
    applyMcpServerState(copy, state);
    expect(copy).toEqual(server);
  });

  it.each(servers)("$label: healing the state is idempotent and clears only plaintext", ({ input }) => {
    const server = createMcpServerSettings(input);
    const state = mcpServerStateFromServer(server);
    const healed = healMcpServerState(state, server.id);

    expect(healed).toEqual({
      ...state,
      authHeaderValue: "",
      oauth: {
        ...state.oauth,
        clientSecret: "",
        accessToken: "",
        refreshToken: "",
      },
    });
    expect(healMcpServerState(healed, server.id)).toEqual(healed);
  });

  it.each(servers)("$label: healMcpSettings is idempotent", ({ input }) => {
    const server = createMcpServerSettings(input);
    const once = healMcpSettings({ servers: [server] });
    expect(healMcpSettings(once)).toEqual(once);
    expect(pick(once.servers[0]!)).toEqual(
      pick({
        ...server,
        authHeaderValue: "",
        oauth: { ...server.oauth, clientSecret: "", accessToken: "", refreshToken: "" },
      }),
    );
  });

  it("keeps healed pending OAuth challenges on the state shape", () => {
    const state = createMcpServerState("docs", {
      enabled: true,
      lastUrl: "https://mcp.example/mcp",
      pendingOAuthChallenge: 'Bearer resource_metadata="https://mcp.example/rm"',
      pendingOAuthResourceUrl: "https://mcp.example/rm",
    });
    expect(healMcpServerState(state, "docs")).toMatchObject({
      pendingOAuthChallenge: 'Bearer resource_metadata="https://mcp.example/rm"',
      pendingOAuthResourceUrl: "https://mcp.example/rm",
      lastUrl: "https://mcp.example/mcp",
    });
  });

  it("pins the shared defaults for both shapes", () => {
    expect(createMcpServerState("docs")).toMatchObject({
      enabled: false,
      approval: "ask",
      authType: "none",
      authHeaderName: "",
      authHeaderValue: "",
      knownTools: [],
      enabledTools: [],
      disabledTools: [],
      oauth: expect.objectContaining({ accessToken: "", refreshToken: "", clientSecret: "" }),
    });
    expect(healMcpServerState({}, "docs")).toEqual(createMcpServerState("docs"));
    expect(createMcpServerSettings({ id: "docs", url: "https://mcp.example/mcp" })).toMatchObject({
      enabled: true,
      approval: "ask",
      authType: "none",
      authHeaderName: "",
      authHeaderValue: "",
      knownTools: [],
      enabledTools: [],
      disabledTools: [],
    });
    expect(healMcpSettings({ servers: [] })).toEqual({
      enabled: false,
      proxyUrl: "",
      noProxy: "localhost,127.0.0.1,::1",
      servers: [],
    });
  });
});
