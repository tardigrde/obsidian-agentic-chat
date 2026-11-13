import { describe, expect, it } from "vitest";
import { createMcpServerSettings, createMcpServerState, type McpServerState } from "../src/mcp/settings";
import { clearAuthForUrlChange, pruneMcpState, syncMcpServerState } from "../src/mcp/server-state";
import type { ApprovalSettings } from "../src/agent/approval";

function state(id = "docs", overrides: Partial<McpServerState> = {}): McpServerState {
  return createMcpServerState(id, overrides);
}

describe("clearAuthForUrlChange", () => {
  const secrets = {
    authHeaderValue: "static-secret",
    oauth: {
      ...createMcpServerSettings().oauth,
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1234,
    },
    knownTools: [{ name: "old_tool", title: "Old", readOnlyHint: false }],
    pendingOAuthChallenge: 'Bearer resource_metadata="https://old.example/rm"',
    pendingOAuthResourceUrl: "https://old.example/rm",
  };

  it.each([
    ["state", () => state("docs", secrets)],
    ["server-shaped copy", () => ({ ...createMcpServerSettings({ id: "docs" }), ...secrets })],
  ])("drops endpoint-bound auth, tools, and challenge on a %s", (_label, make) => {
    const target = make();
    const result = clearAuthForUrlChange(target);

    expect(result).toBe(target);
    expect(target).toMatchObject({
      authHeaderValue: "",
      oauth: expect.objectContaining({ accessToken: "", refreshToken: "", expiresAt: 0 }),
      knownTools: [],
      pendingOAuthChallenge: undefined,
      pendingOAuthResourceUrl: undefined,
    });
  });

  it("keeps configuration that is not bound to the old endpoint", () => {
    const target = state("docs", {
      ...secrets,
      enabled: true,
      approval: "deny",
      authType: "oauth",
      authHeaderName: "X-Tenant",
      enabledTools: ["read_*"],
      disabledTools: ["*_danger"],
      lastUrl: "https://old.example/mcp",
    });
    clearAuthForUrlChange(target);
    expect(target).toMatchObject({
      enabled: true,
      approval: "deny",
      authType: "oauth",
      authHeaderName: "X-Tenant",
      enabledTools: ["read_*"],
      disabledTools: ["*_danger"],
      lastUrl: "https://old.example/mcp",
    });
  });
});

describe("pruneMcpState", () => {
  function target(ids: string[]): { plugins: { mcpState: Record<string, McpServerState> }; approval: ApprovalSettings } {
    return {
      plugins: { mcpState: Object.fromEntries(ids.map((id) => [id, state(id)])) },
      approval: {
        mutating: "ask",
        perTool: Object.fromEntries(ids.map((id) => [`mcp__${id}__tool`, "allow" as const])),
      },
    };
  }

  it.each([
    {
      label: "deletes an orphan and its per-tool approvals",
      ids: ["alive", "orphan"],
      alive: ["alive"],
      keep: undefined,
      mutated: true,
      remaining: ["alive"],
      approvals: ["alive"],
    },
    {
      label: "keeps a live id",
      ids: ["alive"],
      alive: ["alive"],
      keep: undefined,
      mutated: false,
      remaining: ["alive"],
      approvals: ["alive"],
    },
    {
      label: "keeps an id another owner still uses",
      ids: ["legacy", "orphan"],
      alive: [],
      keep: (id: string) => id === "legacy",
      mutated: true,
      remaining: ["legacy"],
      approvals: ["legacy"],
    },
  ])("$label", ({ ids, alive, keep, mutated, remaining, approvals }) => {
    const settings = target(ids);
    expect(pruneMcpState(settings, new Set(alive), keep)).toBe(mutated);
    expect(Object.keys(settings.plugins.mcpState).sort()).toEqual([...remaining].sort());
    expect(Object.keys(settings.approval.perTool).sort()).toEqual(approvals.map((id) => `mcp__${id}__tool`).sort());
  });
});

describe("syncMcpServerState", () => {
  it("mirrors every client-owned server field onto the state record", () => {
    const server = {
      ...createMcpServerSettings({
        id: "docs",
        name: "Docs",
        url: "https://new.example/mcp",
        enabled: true,
        approval: "allow",
        enabledTools: ["read_*"],
        disabledTools: ["*_danger"],
      }),
      source: "plugin" as const,
      authHeaderValue: "secret",
      pendingOAuthChallenge: "Bearer",
      pendingOAuthResourceUrl: "https://new.example/rm",
    };
    const record = state("docs", { lastUrl: "https://old.example/mcp" });

    syncMcpServerState(record, server);

    expect(record).toMatchObject({
      enabled: true,
      approval: "allow",
      authHeaderValue: "secret",
      enabledTools: ["read_*"],
      disabledTools: ["*_danger"],
      lastUrl: "https://new.example/mcp",
      pendingOAuthChallenge: "Bearer",
      pendingOAuthResourceUrl: "https://new.example/rm",
    });
  });

  it("drops lastUrl when the server url is empty", () => {
    const server = { ...createMcpServerSettings({ id: "docs", url: "https://x.example/mcp" }), url: "" };
    const record = state("docs", { lastUrl: "https://old.example/mcp" });
    syncMcpServerState(record, server);
    expect(record.lastUrl).toBeUndefined();
  });
});
