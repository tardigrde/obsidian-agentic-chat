import { browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { createServer, type Server } from "node:http";
import { mark } from "../../support/record";
import {
  clickMcpAddButton,
  closeAgenticChatSettings,
  openAgenticChatSettings,
  readAgenticChatSettings,
  selectSettingsTab,
  setSettingTextByPlaceholder,
  setSettingToggle,
  waitForAgenticChatSetting,
  waitForMcpAddRow,
  waitForSetting,
} from "../../support/settings-ui";

interface SettingsSnapshot {
  mcp: { enabled: boolean; servers: Array<{ id: string; name: string; url: string; source: string }> };
  plugins: { mcpState?: Record<string, { knownTools?: Array<{ name: string }> }> };
}

const PACKAGE_NAME = "probe-local";
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
              serverInfo: { name: "probe-mcp", version: "1.0.0" },
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

describe("probe: settings MCP rows", function () {
  this.timeout(180_000);
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
          plugins?: Record<string, { settings?: { mcp?: { enabled?: boolean; servers?: unknown[] } }; saveSettings?: () => Promise<void> }>;
        };
      }).plugins?.plugins?.["agentic-chat"];
      if (plugin?.settings?.mcp) {
        plugin.settings.mcp.enabled = false;
        plugin.settings.mcp.servers = [];
        await plugin.saveSettings?.();
      }
    }, PACKAGE_PATH);
  });

  after(async function () {
    await closeAgenticChatSettings();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  it("records page navigation, add, test, and remove for an MCP server", async function () {
    await openAgenticChatSettings();

    await selectSettingsTab("Models");
    await waitForSetting("Model provider");
    await mark("models page");
    await browser.pause(800);

    await selectSettingsTab("Agent");
    await waitForSetting("Permission mode");
    await mark("agent page");
    await browser.pause(800);

    await selectSettingsTab("Advanced");
    await waitForSetting("Enable MCP");
    await mark("advanced page");
    await browser.pause(800);

    await setSettingToggle("Enable MCP", true);
    await waitForMcpAddRow();
    await mark("mcp enabled");
    await browser.pause(600);

    await setSettingTextByPlaceholder("Server name", PACKAGE_NAME);
    await setSettingTextByPlaceholder("https://mcp.example.com/mcp", url);
    await clickMcpAddButton("Add MCP server");
    await waitForSetting("Setup guide");
    await waitForAgenticChatSetting((settings) => {
      const snapshot = settings as unknown as SettingsSnapshot;
      return Object.keys(snapshot.plugins.mcpState ?? {}).some((id) => id.includes("probe_local"));
    }, "MCP package did not create a server state row");
    await mark("mcp server added");
    await browser.pause(800);

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
    await waitForSetting("Tool approvals");
    await mark("mcp test connection");
    await browser.pause(1_200);

    const removed = await browser.execute((packageName) => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-plugin-row"));
      const row = rows.find((candidate) => candidate.textContent?.includes(packageName));
      const button = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (candidate) => candidate.innerText.trim() === "Remove",
      );
      if (!button) return false;
      button.click();
      return true;
    }, PACKAGE_NAME);
    expect(removed).toBe(true);

    await browser.waitUntil(
      async () => {
        const settings = await readAgenticChatSettings<SettingsSnapshot>();
        return Object.keys(settings.plugins.mcpState ?? {}).every((id) => !id.includes("probe_local"));
      },
      { timeout: 10_000, timeoutMsg: "Removing the package left its MCP state behind" },
    );
    await mark("mcp server removed");
    await browser.pause(800);
  });
});
