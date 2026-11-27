import { browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { createServer, type Server } from "node:http";
import {
  clickConfirmModalButton,
  clickMcpAddButton,
  closeAgenticChatSettings,
  openAgenticChatSettings,
  openMcpAdvancedFolds,
  readAgenticChatSettings,
  selectSettingsTab,
  setSettingTextByPlaceholder,
  setSettingToggle,
  waitForAgenticChatSetting,
  waitForMcpAddRow,
  waitForSetting,
} from "../support/settings-ui";

interface SettingsSnapshot {
  mcp: { enabled: boolean };
  plugins: {
    folder: string;
    mcpState?: Record<string, { knownTools?: Array<{ name: string }> }>;
  };
}

const PACKAGE_NAME = "e2e-local";
const PACKAGE_PATH = `.agentic-plugins/${PACKAGE_NAME}`;

function startMcpStub(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      let message: { id?: number | string; method?: string };
      try {
        message = JSON.parse(body) as { id?: number | string; method?: string };
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              serverInfo: { name: "e2e-mcp", version: "1.0.0" },
              capabilities: { tools: {} },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "echo",
                    title: "Echo",
                    description: "Echo text back",
                    inputSchema: { type: "object", properties: { text: { type: "string" } } },
                  },
                ],
              }
            : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("MCP stub did not bind");
      resolve({ server, url: `http://127.0.0.1:${address.port}/mcp` });
    });
  });
}

describe("settings MCP dynamic rows", function () {
  let stub: Server;
  let url = "";

  before(async function () {
    const started = await startMcpStub();
    stub = started.server;
    url = started.url;

    await browser.executeObsidian(async ({ app }, packagePath) => {
      const existing = app.vault.getAbstractFileByPath(packagePath);
      if (existing) await app.vault.delete(existing, true);
      const plugin = (app as unknown as {
        plugins?: {
          plugins?: Record<string, { settings?: { mcp?: { enabled?: boolean } }; saveSettings?: () => Promise<void> }>;
        };
      }).plugins?.plugins?.["agentic-chat"];
      if (plugin?.settings?.mcp) {
        plugin.settings.mcp.enabled = false;
        await plugin.saveSettings?.();
      }
    }, PACKAGE_PATH);

    await openAgenticChatSettings();
    await selectSettingsTab("Advanced");
    // Toggle through the UI so the declarative tab rebuilds its definitions.
    await setSettingToggle("Enable MCP", true);
    await waitForMcpAddRow();
  });

  after(async function () {
    await closeAgenticChatSettings();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  it("adds a server, tests it, and removes its package", async function () {
    this.timeout(60_000);

    await setSettingTextByPlaceholder("Server name", PACKAGE_NAME);
    await setSettingTextByPlaceholder("https://mcp.example.com/mcp", url);
    await clickMcpAddButton("Add MCP server");

    await waitForSetting("Approval");
    await waitForAgenticChatSetting((settings) => {
      const snapshot = settings as unknown as SettingsSnapshot;
      return Object.keys(snapshot.plugins.mcpState ?? {}).some((id) => id.includes("e2e_local"));
    }, "MCP package did not create a server state row");

    const clicked = await browser.execute(() => {
      const header = document.querySelector<HTMLElement>(".agentic-chat-mcp-server-header");
      const button = Array.from(header?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (candidate) => candidate.innerText.trim() === "Test connection",
      );
      if (!button) return false;
      button.click();
      return true;
    });
    expect(clicked).toBe(true);

    await waitForAgenticChatSetting((settings) => {
      const snapshot = settings as unknown as SettingsSnapshot;
      return Object.values(snapshot.plugins.mcpState ?? {}).some((state) =>
        state.knownTools?.some((tool) => tool.name === "echo"),
      );
    }, "Test connection did not cache the discovered MCP tool");
    await openMcpAdvancedFolds();
    await waitForSetting("Tool approvals");

    // U7 #5: the server's own Remove button is enabled for a package that holds only
    // this server, asks first, then removes the package (it was disabled and silent).
    const removeEnabled = await browser.execute(() => {
      const header = document.querySelector<HTMLElement>(".agentic-chat-mcp-server-header");
      const button = Array.from(header?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (candidate) => candidate.innerText.trim() === "Remove",
      );
      if (!button || button.disabled) return false;
      button.click();
      return true;
    });
    expect(removeEnabled).toBe(true);
    // Cancelling keeps the server.
    await clickConfirmModalButton("Cancel");
    expect(Object.keys((await readAgenticChatSettings<SettingsSnapshot>()).plugins.mcpState ?? {}).some((id) => id.includes("e2e_local"))).toBe(true);
    await browser.execute(() => {
      const header = document.querySelector<HTMLElement>(".agentic-chat-mcp-server-header");
      Array.from(header?.querySelectorAll<HTMLButtonElement>("button") ?? [])
        .find((candidate) => candidate.innerText.trim() === "Remove")
        ?.click();
    });
    await clickConfirmModalButton("Remove");

    await browser.waitUntil(
      async () => {
        const settings = await readAgenticChatSettings<SettingsSnapshot>();
        return Object.keys(settings.plugins.mcpState ?? {}).every((id) => !id.includes("e2e_local"));
      },
      { timeout: 10_000, timeoutMsg: "Removing the package left its MCP state behind" },
    );
    const settingsAfter = await readAgenticChatSettings<SettingsSnapshot>();
    expect("servers" in settingsAfter.mcp).toBe(false);
  });

  it("shows the OAuth banner for a bare MCP server whose 401 advertises resource_metadata (no auto-redirect)", async function () {
    this.timeout(30_000);
    // Moved from composio-install.e2e.ts (#393 T13). A pending OAuth challenge
    // stands in for the 401: the banner must offer "Authenticate & test" and
    // must not start a redirect by itself.
    await closeAgenticChatSettings();
    const setServer = async (add: boolean): Promise<void> => {
      await browser.executeObsidian(async ({ app }, shouldAdd) => {
        const plugin = (app as unknown as {
          plugins: {
            plugins: Record<
              string,
              {
                settings: { mcp: { enabled: boolean }; plugins: { mcpState: Record<string, Record<string, unknown>> } };
                pluginService?: { generateMcpServerPackage: (input: { serverName: string; url: string }) => Promise<{ rootPath: string }> };
                saveSettings: () => Promise<void>;
              }
            >;
          };
        }).plugins.plugins["agentic-chat"];
        const folder = ".agentic-plugins/e2e-bare-oauth";
        const existing = app.vault.getAbstractFileByPath(folder);
        if (existing) await app.vault.delete(existing, true);
        const stateId = Object.keys(plugin.settings.plugins.mcpState).find((id) => id.includes("e2e_bare_oauth"));
        if (stateId) delete plugin.settings.plugins.mcpState[stateId];
        if (shouldAdd) {
          plugin.settings.mcp.enabled = true;
          if (!plugin.pluginService) throw new Error("pluginService is unavailable");
          await plugin.pluginService.generateMcpServerPackage({
            serverName: "e2e-bare-oauth",
            url: "https://mcp.example.com/mcp",
          });
          const id = Object.keys(plugin.settings.plugins.mcpState).find((candidate) => candidate.includes("e2e_bare_oauth"));
          if (!id) throw new Error("generated MCP package did not create state");
          const state = plugin.settings.plugins.mcpState[id];
          state.pendingOAuthChallenge =
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"';
          state.pendingOAuthResourceUrl = "https://mcp.example.com/.well-known/oauth-protected-resource";
        }
        await plugin.saveSettings();
      }, add);
    };
    await setServer(true);
    try {
      await openAgenticChatSettings();
      await selectSettingsTab("Advanced");
      await browser.waitUntil(
        async () =>
          await browser.execute(() => {
            const text = document.body.textContent ?? "";
            const button = Array.from(document.querySelectorAll("button")).some((b) => b.innerText.trim() === "Authenticate & test");
            return text.includes("requires OAuth") && button;
          }),
        { timeout: 5_000, timeoutMsg: "the bare MCP OAuth banner or its Authenticate & test button did not render" },
      );
    } finally {
      await closeAgenticChatSettings();
      await setServer(false);
    }
  });
});
