import { describe, expect, it } from "vitest";
import { createMcpServerSettings } from "../src/mcp/settings";
import {
  formatMcpAuthType,
  formatMcpServerSummary,
  formatMcpToolApprovalDescription,
  formatMcpToolSample,
  mcpCredentialResourceChanged,
  mcpCredentialResourceState,
  mcpKnownToolLocalName,
  mcpSecretIds,
  mcpTestButtonState,
} from "../src/settings-mcp-state";

describe("MCP settings state helpers", () => {
  it("formats server auth, summary, and tool descriptions", () => {
    const server = createMcpServerSettings({
      id: "docs",
      name: "Docs",
      url: "https://mcp.example.com/mcp",
      authType: "bearer",
      authHeaderValue: "token",
      knownTools: [{ name: "search", title: "Search", readOnlyHint: true }],
    });

    expect(formatMcpAuthType(server)).toBe("bearer token set");
    expect(formatMcpServerSummary(server, "")).toBe(
      "https://mcp.example.com/mcp · enabled · bearer token set · 1 discovered tool",
    );
    expect(formatMcpToolApprovalDescription("mcp__docs__search", server.knownTools[0])).toBe(
      "mcp__docs__search · read-only hint",
    );
    expect(formatMcpToolSample(["a", "b", "c", "d", "e", "f"])).toBe(" (a, b, c, d, e)");
  });

  it("reports test button state without forcing OAuth sign-in as an error", () => {
    const oauth = createMcpServerSettings({
      id: "docs",
      url: "https://mcp.example.com/mcp",
      authType: "oauth",
    });
    const bearer = createMcpServerSettings({
      id: "docs",
      url: "https://mcp.example.com/mcp",
      authType: "bearer",
    });

    expect(mcpTestButtonState(oauth)).toMatchObject({
      label: "Authenticate & test",
      needsOAuthSignIn: true,
      problem: "",
    });
    expect(mcpTestButtonState(bearer).problem).toMatch(/bearer token/i);
  });

  it("normalizes credential resource comparisons and secret ids", () => {
    const server = createMcpServerSettings({ id: "docs" });
    expect(mcpCredentialResourceState("https://mcp.example.com/mcp?tools=a")).toEqual({
      kind: "resource",
      value: "https://mcp.example.com/mcp",
    });
    expect(mcpCredentialResourceChanged("https://mcp.example.com/mcp?tools=a", "https://mcp.example.com/mcp?tools=b")).toBe(false);
    expect(mcpCredentialResourceChanged("https://mcp.example.com/mcp", "https://other.example.com/mcp")).toBe(true);
    expect(mcpSecretIds(server)).toEqual([
      "agentic-chat-mcp-docs-auth-header-value",
      "agentic-chat-mcp-docs-oauth-client-secret",
      "agentic-chat-mcp-docs-oauth-access-token",
      "agentic-chat-mcp-docs-oauth-refresh-token",
    ]);
    expect(mcpKnownToolLocalName(server, { name: "search", title: "Search", readOnlyHint: true })).toBe(
      "mcp__docs__search",
    );
  });
});
