import { browser, expect, $ } from "@wdio/globals";
import { after, before, describe, it } from "mocha";

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

type ScriptedTurn = {
  label?: string;
  content: Array<Record<string, unknown>>;
  stopReason?: "stop" | "length" | "toolUse";
};

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

function localMcpToolName(serverId: string, remoteTool: string): string {
  const part = remoteTool
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return `mcp__${serverId}__${part || "tool"}`;
}

function toolTurn(label: string, id: string, name: string, args: Record<string, unknown>): ScriptedTurn {
  return {
    label,
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name, arguments: args }],
  };
}

function textTurn(label: string, text: string): ScriptedTurn {
  return {
    label,
    stopReason: "stop",
    content: [{ type: "text", text }],
  };
}

async function installScriptedTurns(turns: ScriptedTurn[]): Promise<void> {
  await browser.execute((scriptedTurns) => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_TURNS__?: ScriptedTurn[];
      __AGENTIC_CHAT_E2E_CALLS__?: number;
      __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[];
    };
    target.__AGENTIC_CHAT_E2E_TURNS__ = scriptedTurns;
    target.__AGENTIC_CHAT_E2E_CALLS__ = 0;
    target.__AGENTIC_CHAT_E2E_CALL_LOG__ = [];
  }, turns);
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
      enableBuiltinAgents: boolean;
      approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
      web: { enabled: boolean };
      mcp: {
        enabled: boolean;
        proxyUrl: string;
        noProxy: string;
        servers: Array<{
          id: string;
          name: string;
          url: string;
          enabled: boolean;
          authType: string;
          authHeaderName: string;
          authHeaderValueSecretId: string;
          authHeaderValue: string;
          oauth: Record<string, string | number | boolean>;
          approval: string;
          knownTools: Array<{ name: string; title: string; readOnlyHint: boolean }>;
        }>;
      };
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "e2e-scripted-key";
    settings.mode = "safe";
    settings.enableBuiltinAgents = false;
    settings.approval.mutating = "ask";
    settings.approval.perTool = {};
    settings.approval.workingDirs = [];
    settings.web.enabled = false;
    settings.mcp = {
      enabled: true,
      proxyUrl: "",
      noProxy: "localhost,127.0.0.1,::1",
      servers: [
        {
          id: "secure_mcp",
          name: "Secure MCP E2E",
          url: cfg.url,
          enabled: true,
          authType: cfg.headerName ? "header" : "none",
          authHeaderName: cfg.headerName,
          authHeaderValueSecretId: "agentic-chat-mcp-secure-mcp-auth-header-value",
          authHeaderValue: cfg.headerValue,
          oauth: {
            clientId: "",
            clientSecretSecretId: "agentic-chat-mcp-secure-mcp-oauth-client-secret",
            clientSecret: "",
            dynamicClientRegistration: false,
            registeredRedirectUri: "",
            authorizationServer: "",
            authorizationEndpoint: "",
            tokenEndpoint: "",
            registrationEndpoint: "",
            resourceMetadataUrl: "",
            accessTokenSecretId: "agentic-chat-mcp-secure-mcp-oauth-access-token",
            accessToken: "",
            refreshTokenSecretId: "agentic-chat-mcp-secure-mcp-oauth-refresh-token",
            refreshToken: "",
            expiresAt: 0,
            scope: "",
          },
          approval: "ask",
          knownTools: [],
        },
      ],
    };
    await plugin.saveSettings?.();
    return true;
  }, config);
}

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

async function sendPrompt(prompt: string): Promise<void> {
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(prompt);
  await $(".agentic-chat-send").click();
}

async function allowApproval(localToolName: string): Promise<void> {
  const modal = await $(".agentic-chat-approval");
  await modal.waitForExist({ timeout: 20_000 });
  await expect(modal).toHaveText(new RegExp(localToolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await expect(modal).toHaveText(/obsidian/);
  const allow = await modal.$("button=Allow");
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
  const localTool = config ? localMcpToolName("secure_mcp", config.remoteTool) : "";

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
    await expect($(".agentic-chat-messages")).toHaveText(/MCP e2e finished/);

    const result = await latestMcpToolResult(localTool);
    expect(result).not.toBeNull();
    expect(result?.isError).toBe(false);
    expect(result?.details).toMatchObject({
      serverId: "secure_mcp",
      serverName: "Secure MCP E2E",
      remoteToolName: config.remoteTool,
    });
  });

  after(async function () {
    await browser.execute(() => {
      const target = window as typeof window & {
        __AGENTIC_CHAT_E2E_TURNS__?: ScriptedTurn[];
        __AGENTIC_CHAT_E2E_CALLS__?: number;
        __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[];
      };
      delete target.__AGENTIC_CHAT_E2E_TURNS__;
      delete target.__AGENTIC_CHAT_E2E_CALLS__;
      delete target.__AGENTIC_CHAT_E2E_CALL_LOG__;
    });
  });
});
