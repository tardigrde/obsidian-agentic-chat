import { browser, expect, $ } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { clearScriptedTurns, installScriptedTurns, textTurn, toolTurn } from "../support/scripted-stream";

/**
 * Live MCP e2e: deterministic model turn, real HTTPS MCP server.
 *
 * Required:
 *   AGENTIC_CHAT_E2E_MCP_URL=https://mcp.example.com/mcp
 *
 * Optional:
 *   AGENTIC_CHAT_E2E_MCP_TOOL=tool-name
 *   AGENTIC_CHAT_E2E_MCP_ARGS_JSON='{"input":"value"}'
 *   AGENTIC_CHAT_E2E_MCP_HEADER_NAME=X-API-Key
 *   AGENTIC_CHAT_E2E_MCP_HEADER_VALUE=...
 *
 * The spec refuses non-HTTPS URLs. No local/insecure MCP server is allowed here.
 */

interface McpE2EConfig {
  url: string;
  remoteTool: string;
  args: Record<string, unknown>;
  headerName: string;
  headerValue: string;
}

function readConfig(): McpE2EConfig | null {
  const url = process.env.AGENTIC_CHAT_E2E_MCP_URL?.trim();
  if (!url) return null;
  if (!url.startsWith("https://")) {
    throw new Error("AGENTIC_CHAT_E2E_MCP_URL must start with https://");
  }
  const argsText = process.env.AGENTIC_CHAT_E2E_MCP_ARGS_JSON || '{"query":"obsidian","libraryName":"obsidian"}';
  const parsed = JSON.parse(argsText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AGENTIC_CHAT_E2E_MCP_ARGS_JSON must be a JSON object");
  }
  return {
    url,
    remoteTool: process.env.AGENTIC_CHAT_E2E_MCP_TOOL || "resolve-library-id",
    args: parsed as Record<string, unknown>,
    headerName: process.env.AGENTIC_CHAT_E2E_MCP_HEADER_NAME || "",
    headerValue: process.env.AGENTIC_CHAT_E2E_MCP_HEADER_VALUE || "",
  };
}

const SECURE_MCP_SERVER_ID = "plugin_secure_mcp_3c334e3b2268";

function localMcpToolName(serverId: string, remoteTool: string): string {
  const part = remoteTool
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return `mcp__${serverId}__${part || "tool"}`;
}

async function configurePlugin(config: McpE2EConfig): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, cfg) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) return false;
    const settings = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      mode: string;
      approval: { mutating: string; perTool: Record<string, string> };
      web: { enabled: boolean };
      mcp: {
        enabled: boolean;
        proxyUrl: string;
        noProxy: string;
      };
      plugins: { mcpState: Record<string, Record<string, unknown>> };
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "e2e-scripted-key";
    settings.approval.mutating = "ask";
    settings.approval.perTool = {};
    settings.web.enabled = false;
    settings.mcp = {
      enabled: true,
      proxyUrl: "",
      noProxy: "localhost,127.0.0.1,::1",
    };
    const root = ".agentic-plugins/secure";
    if (!(await app.vault.adapter.exists(root))) {
      await app.vault.adapter.mkdir(root);
      await app.vault.adapter.write(
        `${root}/plugin.json`,
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "secure",
        }),
      );
    }
    await app.vault.adapter.write(
      `${root}/mcp.json`,
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { mcp: { type: "streamable-http", url: cfg.url } },
      }),
    );
    settings.plugins.mcpState["plugin_secure_mcp_3c334e3b2268"] = {
      enabled: true,
      authType: cfg.headerName ? "header" : "none",
      authHeaderName: cfg.headerName,
      authHeaderValueSecretId: "agentic-chat-mcp-plugin_secure_mcp_3c334e3b2268-auth-header-value",
      authHeaderValue: cfg.headerValue,
      enabledTools: [],
      disabledTools: [],
      oauth: {
        clientId: "",
        clientSecretSecretId: "agentic-chat-mcp-plugin_secure_mcp_3c334e3b2268-oauth-client-secret",
        clientSecret: "",
        dynamicClientRegistration: false,
        registeredRedirectUri: "",
        authorizationServer: "",
        authorizationEndpoint: "",
        tokenEndpoint: "",
        registrationEndpoint: "",
        resourceMetadataUrl: "",
        accessTokenSecretId: "agentic-chat-mcp-plugin_secure_mcp_3c334e3b2268-oauth-access-token",
        accessToken: "",
        refreshTokenSecretId: "agentic-chat-mcp-plugin_secure_mcp_3c334e3b2268-oauth-refresh-token",
        refreshToken: "",
        expiresAt: 0,
        scope: "",
      },
      approval: "ask",
      knownTools: [],
      lastUrl: cfg.url,
    };
    await plugin.saveSettings?.();
    return true;
  }, config);
}

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $('[data-ac="view"]').waitForExist();
}

async function sendPrompt(prompt: string): Promise<void> {
  const input = await $('[data-ac="composer-input"]');
  await input.click();
  await input.setValue(prompt);
  await $('[data-ac="send"]').click();
}

async function allowApproval(localToolName: string): Promise<void> {
  const modal = await $('[data-ac="approval"]:not(.is-resolved)');
  await modal.waitForExist({ timeout: 20_000 });
  await expect(modal).toHaveText(new RegExp(localToolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await expect(modal).toHaveText(/obsidian/);
  const allow = await modal.$('[data-ac="approval-allow"]');
  await allow.waitForExist({ timeout: 5_000 });
  await allow.click();
  await modal.waitForExist({ reverse: true, timeout: 5_000 });
}

async function latestMcpToolResult(localToolName: string): Promise<{ isError?: boolean; details?: Record<string, unknown> } | null> {
  return await browser.executeObsidian(async ({ app }, toolName) => {
    const leaf = app.workspace.getLeavesOfType("agentic-chat-chat-view")[0];
    const view = leaf?.view as unknown as { service?: { getMessages: () => unknown[] } } | undefined;
    const messages = view?.service?.getMessages?.() ?? [];
    const matches = messages.filter((message): message is { role: string; toolName: string; isError?: boolean; details?: Record<string, unknown> } => {
      return (
        !!message &&
        typeof message === "object" &&
        (message as { role?: unknown }).role === "toolResult" &&
        (message as { toolName?: unknown }).toolName === toolName
      );
    });
    return matches.at(-1) ?? null;
  }, localToolName);
}

describe("agentic-chat live MCP over HTTPS", function () {
  const config = readConfig();
  const localTool = config ? localMcpToolName(SECURE_MCP_SERVER_ID, config.remoteTool) : "";

  before(async function () {
    if (!config) this.skip();
    await installScriptedTurns([
      toolTurn("mcp tool call", "e2e-mcp-call", localTool, config.args),
      textTurn("mcp final", "MCP e2e finished."),
    ]);
    const configured = await configurePlugin(config);
    if (!configured) throw new Error("agentic-chat plugin not found in the test vault");
    await openChat();
  });

  it("discovers and calls a tool from a secure MCP server", async function () {
    if (!config) this.skip();
    await sendPrompt("call the configured secure MCP server");
    await allowApproval(localTool);
    await expect($('[data-ac="messages"]')).toHaveText(/MCP e2e finished/);

    const result = await latestMcpToolResult(localTool);
    expect(result).not.toBeNull();
    expect(result?.isError).toBe(false);
    expect(result?.details).toMatchObject({
      serverId: SECURE_MCP_SERVER_ID,
      serverName: "secure: mcp",
      remoteToolName: config.remoteTool,
    });
  });

  after(async function () {
    await clearScriptedTurns();
  });
});
